/**
 * Deploy TestUSD + JingleSettlement to Monad testnet from the treasury key, then:
 *   mint 10,000 tUSD to the treasury, approve the settlement contract, fund the dispute reserve with 500 tUSD.
 * Writes deployments/monad-testnet.json (addresses + tx hashes; committed, no secrets).
 * Run: npm run deploy:monad      needs .env MONAD_PRIVATE_KEY and testnet MON for gas (faucet.monad.xyz)
 */
import "dotenv/config";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { formatEther, parseUnits, type Address, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { MONAD_TESTNET_DEFAULTS } from "../packages/monad/src/chain.js";
import { deploymentPath, loadArtifact, publicClientFor, walletClientFor, type Deployment } from "../packages/monad/src/clients.js";

const MINT = parseUnits("10000", 6);
const RESERVE = parseUnits("500", 6);

const main = async () => {
  const pub = publicClientFor();
  const wallet = walletClientFor();
  const treasury = wallet.account.address;
  const chainId = await pub.getChainId();
  const bal = await pub.getBalance({ address: treasury });
  console.log(`chain ${chainId}  treasury ${treasury}  MON ${formatEther(bal)}`);
  if (bal === 0n) {
    console.error(`✗ treasury has no MON for gas. Fund ${treasury} at https://faucet.monad.xyz and rerun.`);
    process.exit(1);
  }

  const txs: Record<string, Hex> = {};
  const wait = async (label: string, hash: Hex) => {
    txs[label] = hash;
    const r = await pub.waitForTransactionReceipt({ hash });
    if (r.status !== "success") throw new Error(`${label} reverted: ${hash}`);
    console.log(`✓ ${label.padEnd(18)} ${hash}  block ${r.blockNumber}`);
    return r;
  };

  const usdArt = loadArtifact("TestUSD");
  const usdHash = await wallet.deployContract({ abi: usdArt.abi, bytecode: usdArt.bytecode, chain: wallet.chain, account: wallet.account });
  const usdReceipt = await wait("deployTestUsd", usdHash);
  const testUsd = usdReceipt.contractAddress as Address;

  const setArt = loadArtifact("JingleSettlement");
  const setHash = await wallet.deployContract({ abi: setArt.abi, bytecode: setArt.bytecode, args: [testUsd, treasury], chain: wallet.chain, account: wallet.account });
  const setReceipt = await wait("deploySettlement", setHash);
  const settlement = setReceipt.contractAddress as Address;

  await wait("mint", await wallet.writeContract({ address: testUsd, abi: usdArt.abi, functionName: "mint", args: [treasury, MINT], chain: wallet.chain, account: wallet.account }));
  await wait("approve", await wallet.writeContract({ address: testUsd, abi: usdArt.abi, functionName: "approve", args: [settlement, 2n ** 256n - 1n], chain: wallet.chain, account: wallet.account }));
  await wait("fundReserve", await wallet.writeContract({ address: settlement, abi: setArt.abi, functionName: "fundReserve", args: [RESERVE], chain: wallet.chain, account: wallet.account }));

  // Demo merchant: a fresh address (no key needed; the studio only ever receives). Override with MONAD_MERCHANT_ADDRESS.
  const merchant = (process.env.MONAD_MERCHANT_ADDRESS as Address | undefined) ?? privateKeyToAccount(generatePrivateKey()).address;

  const dep: Deployment = {
    chainId,
    rpcUrl: process.env.MONAD_RPC_URL ?? MONAD_TESTNET_DEFAULTS.rpcUrl,
    explorerUrl: process.env.MONAD_EXPLORER_URL ?? MONAD_TESTNET_DEFAULTS.explorerUrl,
    deployedAt: new Date().toISOString(),
    treasury,
    merchant,
    testUsd,
    settlement,
    txs,
  };
  const path = deploymentPath();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(dep, null, 2) + "\n");
  console.log(`\nTestUSD          ${testUsd}\nJingleSettlement ${settlement}\nmerchant         ${merchant}\n-> ${path}\n`);
  console.log(`explorer: ${dep.explorerUrl}/address/${settlement}`);
};

main().catch((err) => {
  console.error("✗", err instanceof Error ? err.message : err);
  process.exit(1);
});
