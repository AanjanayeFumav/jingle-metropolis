/**
 * One-shot migration: the Jingle treasury / operator becomes a Privy server wallet, scoped by a Privy policy.
 *   1. create a policy (eth_signTransaction only to JingleSettlement settle/absorbDispute, setOperator back to the
 *      old treasury for rollback, and TestUSD approve(spender = JingleSettlement))
 *   2. create the Privy wallet with that policy
 *   3. raw key: send 1 MON (gas) and 5,000 tUSD to it
 *   4. Privy wallet: approve(settlement, max)   <- first real Privy signature; stops here if it fails
 *   5. raw key: setOperator(privy address)
 *   6. write treasury / treasurySigner / privy ids / previousTreasury into deployments/monad-testnet.json
 * Every step checks chain state first, so a rerun resumes instead of repeating. Prints tx hashes and the .env
 * lines to add; never prints secrets.
 *
 * Rollback: npm run privy:treasury -- --rollback
 *   setOperator is onlyOperator, so the raw key cannot take the role back by itself: the Privy wallet signs
 *   setOperator(previous treasury) (the policy allows exactly that), then the deployment file is restored.
 *
 * Run: npm run privy:treasury      needs .env MONAD_PRIVATE_KEY, PRIVY_APP_ID, PRIVY_APP_SECRET
 */
import "dotenv/config";
import { writeFileSync } from "node:fs";
import { formatEther, getAddress, maxUint256, parseEther, parseUnits, type Abi, type AbiFunction, type Address, type Hex } from "viem";
import { deploymentPath, loadArtifact, loadDeployment, privyWalletClientFor, publicClientFor, rawKeyWalletClientFor, type Deployment } from "../packages/monad/src/clients.js";
import { RestPrivyClient, type PrivyPolicyInput } from "../packages/privy/src/client.js";

const GAS_MON = parseEther("1");
const FLOAT_USD = parseUnits("5000", 6);

const env = process.env;
if (!env.PRIVY_APP_ID || !env.PRIVY_APP_SECRET) {
  console.error("✗ set PRIVY_APP_ID and PRIVY_APP_SECRET in .env first");
  process.exit(1);
}
const privy = new RestPrivyClient({ appId: env.PRIVY_APP_ID, appSecret: env.PRIVY_APP_SECRET });
const pub = publicClientFor(env);
const settlementAbi = loadArtifact("JingleSettlement").abi;
const usdAbi = loadArtifact("TestUSD").abi;
const fn = (abi: Abi, name: string) => abi.find((e): e is AbiFunction => e.type === "function" && e.name === name)!;

function save(d: Deployment) {
  writeFileSync(deploymentPath(), JSON.stringify(d, null, 2) + "\n");
  console.log(`✓ wrote ${deploymentPath()}`);
}

async function wait(label: string, hash: Hex) {
  const r = await pub.waitForTransactionReceipt({ hash });
  console.log(`  ${r.status === "success" ? "✓" : "✗"} ${label}: ${hash} (block ${r.blockNumber})`);
  if (r.status !== "success") throw new Error(`${label} reverted: ${hash}`);
  return hash;
}

function policyFor(d: Deployment, oldTreasury: Address, withCalldata: boolean): PrivyPolicyInput {
  const chain = { field_source: "ethereum_transaction" as const, field: "chain_id", operator: "eq" as const, value: String(d.chainId) };
  const toSettlement = { field_source: "ethereum_transaction" as const, field: "to", operator: "eq" as const, value: getAddress(d.settlement) };
  const toUsd = { field_source: "ethereum_transaction" as const, field: "to", operator: "eq" as const, value: getAddress(d.testUsd) };
  const call = (abi: Abi, name: string, field: string, operator: "eq" | "gte", value: string) =>
    withCalldata ? [{ field_source: "ethereum_calldata" as const, field: `${name}.${field}`, abi: [fn(abi, name)], operator, value }] : [];
  const rule = (name: string, conditions: PrivyPolicyInput["rules"][number]["conditions"]) => ({ name, method: "eth_signTransaction", conditions, action: "ALLOW" as const });
  return {
    name: "Jingle treasury: settlement only",
    rules: withCalldata
      ? [
          rule("settle on JingleSettlement", [chain, toSettlement, ...call(settlementAbi, "settle", "net", "gte", "0")]),
          rule("absorbDispute on JingleSettlement", [chain, toSettlement, ...call(settlementAbi, "absorbDispute", "amount", "gte", "0")]),
          rule("setOperator back to old treasury", [chain, toSettlement, ...call(settlementAbi, "setOperator", "next", "eq", getAddress(oldTreasury))]),
          rule("approve JingleSettlement on TestUSD", [chain, toUsd, ...call(usdAbi, "approve", "spender", "eq", getAddress(d.settlement))]),
        ]
      : [rule("JingleSettlement only", [chain, toSettlement]), rule("TestUSD (approve)", [chain, toUsd])],
  };
}

async function migrate() {
  const d = loadDeployment();
  const raw = rawKeyWalletClientFor(env);
  const rawAddr = raw.account.address;
  if (d.treasurySigner === "privy") {
    console.log(`already migrated: treasury ${d.treasury} (Privy wallet ${d.privyTreasuryWalletId}). Rollback: npm run privy:treasury -- --rollback`);
    return;
  }
  if (rawAddr.toLowerCase() !== d.treasury.toLowerCase()) throw new Error(`MONAD_PRIVATE_KEY is ${rawAddr}, deployment treasury is ${d.treasury}`);
  console.log(`chain ${d.chainId}  raw treasury ${rawAddr}  settlement ${d.settlement}`);

  // 1. policy (calldata-scoped; falls back to address-scoped; then to none, said out loud)
  let policyId: string | null = null;
  for (const withCalldata of [true, false]) {
    try {
      policyId = (await privy.createPolicy(policyFor(d, rawAddr, withCalldata), `jingle-treasury-policy-v1-${withCalldata ? "calldata" : "to"}`)).id;
      console.log(`✓ policy ${policyId} (${withCalldata ? "function + argument scoped" : "contract-address scoped"})`);
      break;
    } catch (err) {
      console.warn(`! policy (${withCalldata ? "calldata" : "address"} rules) rejected: ${err instanceof Error ? err.message : err}`);
    }
  }
  if (!policyId) console.warn("! continuing WITHOUT a policy");

  // 2. wallet
  const w = await privy.createWallet({ idempotencyKey: `jingle-treasury-v1-${policyId ?? "nopolicy"}`, displayName: "Jingle treasury", policyIds: policyId ? [policyId] : undefined });
  console.log(`✓ Privy wallet ${w.id}  address ${w.address}`);
  const pv = privyWalletClientFor(env, { walletId: w.id, address: w.address });
  const txs: Record<string, Hex> = {};

  // 3. fund from the raw key
  const mon = await pub.getBalance({ address: w.address });
  if (mon < GAS_MON / 2n) txs.privyGas = await wait("1 MON for gas", await raw.sendTransaction({ to: w.address, value: GAS_MON, chain: raw.chain, account: raw.account }));
  else console.log(`  - gas already there (${formatEther(mon)} MON)`);
  const usd = (await pub.readContract({ address: d.testUsd, abi: usdAbi, functionName: "balanceOf", args: [w.address] })) as bigint;
  if (usd < FLOAT_USD / 2n) txs.privyFloat = await wait("5,000 tUSD float", await raw.writeContract({ address: d.testUsd, abi: usdAbi, functionName: "transfer", args: [w.address, FLOAT_USD], chain: raw.chain, account: raw.account }));
  else console.log(`  - float already there (${Number(usd) / 1e6} tUSD)`);

  // 4. the first Privy signature
  const allowance = (await pub.readContract({ address: d.testUsd, abi: usdAbi, functionName: "allowance", args: [w.address, d.settlement] })) as bigint;
  if (allowance < FLOAT_USD) {
    try {
      txs.privyApprove = await wait("approve(settlement, max) signed by Privy", await pv.writeContract({ address: d.testUsd, abi: usdAbi, functionName: "approve", args: [d.settlement, maxUint256], chain: pv.chain, account: pv.account }));
    } catch (err) {
      console.error(`✗ Privy signing failed; the operator was NOT changed, the demo still runs on the raw key.\n  ${err instanceof Error ? err.message : err}`);
      process.exit(1);
    }
  } else console.log("  - approval already there");

  // 5. hand over the operator role
  const operator = (await pub.readContract({ address: d.settlement, abi: settlementAbi, functionName: "operator" })) as Address;
  if (operator.toLowerCase() !== w.address.toLowerCase()) {
    txs.setOperatorPrivy = await wait("setOperator(privy) from the raw key", await raw.writeContract({ address: d.settlement, abi: settlementAbi, functionName: "setOperator", args: [w.address], chain: raw.chain, account: raw.account }));
  }

  // 6. record
  save({ ...d, treasury: w.address, treasurySigner: "privy", privyTreasuryWalletId: w.id, privyPolicyId: policyId, previousTreasury: rawAddr, txs: { ...d.txs, ...txs } });
  console.log(`\nAdd to .env (ids only, no secrets), then restart npm run dev:monad:\n  TREASURY_SIGNER=privy\n  PRIVY_TREASURY_WALLET_ID=${w.id}\n  PRIVY_TREASURY_ADDRESS=${w.address}`);
}

async function rollback() {
  const d = loadDeployment();
  if (d.treasurySigner !== "privy" || !d.previousTreasury || !d.privyTreasuryWalletId) {
    console.log("nothing to roll back: treasury signer is the raw key");
    return;
  }
  const pv = privyWalletClientFor(env, { walletId: d.privyTreasuryWalletId, address: d.treasury });
  const operator = (await pub.readContract({ address: d.settlement, abi: settlementAbi, functionName: "operator" })) as Address;
  const txs: Record<string, Hex> = {};
  if (operator.toLowerCase() !== d.previousTreasury.toLowerCase()) {
    txs.setOperatorRaw = await wait("setOperator(raw) signed by Privy", await pv.writeContract({ address: d.settlement, abi: settlementAbi, functionName: "setOperator", args: [d.previousTreasury], chain: pv.chain, account: pv.account }));
  }
  save({ ...d, treasury: d.previousTreasury, treasurySigner: "raw", txs: { ...d.txs, ...txs } });
  console.log("\nRemove TREASURY_SIGNER from .env (or set it to raw), then restart npm run dev:monad.");
}

(process.argv.includes("--rollback") ? rollback() : migrate()).catch((err) => {
  console.error("✗", err instanceof Error ? err.message : err);
  process.exit(1);
});
