/**
 * Session 2 steps 2–3: merchant bank (external account) + Fumav treasury wallet + simulated USDC deposit.
 * Run: npm run setup:bridge [-- --deposit 500 --chain solana]
 */
import { BridgeApiError, type BridgeChain } from "../packages/bridge/src/client.js";
import { argValue } from "./_astra.js";
import { MERCHANT_ADDRESS, bridgeFromEnv, failBridge } from "./_bridge.js";
import { readState, writeState } from "./_state.js";

const client = bridgeFromEnv();

const main = async () => {
  const s = readState().bridge ?? {};
  if (!s.fumav_customer_id || !s.merchant_customer_id) {
    console.error("✗ Run npm run customers:bridge first.");
    process.exit(1);
  }

  // --- treasury wallet ---
  let wallet = s.treasury_wallet_id;
  if (!wallet) {
    const chain = (argValue("--chain") ?? "solana") as BridgeChain;
    console.log(`→ Creating Fumav treasury Bridge wallet on ${chain}…`);
    const w = await client.createWallet(s.fumav_customer_id, chain);
    wallet = w.id;
    writeState({ bridge: { treasury_wallet_id: wallet } });
    console.log(`✓ treasury wallet: ${wallet} (${w.chain} ${w.address})`);
  } else {
    console.log(`✓ treasury wallet already in state: ${wallet}`);
  }

  // --- fund it (sandbox) ---
  const deposit = argValue("--deposit") ?? "500.00";
  console.log(`→ simulate_deposit ${deposit} usdc into ${wallet}…`);
  try {
    const dep = await client.simulateDeposit(s.fumav_customer_id, wallet, { amount: deposit, currency: "usdc" });
    console.log(`✓ ${JSON.stringify(dep)}`);
  } catch (err) {
    console.log(`⚠ simulate_deposit refused: ${err instanceof BridgeApiError ? `${err.status} ${JSON.stringify(err.body)}` : String(err)} — wallet stays unfunded; ask Bridge to enable sandbox simulation on this key.`);
  }

  const wallets = await client.listWallets(s.fumav_customer_id);
  for (const w of wallets) {
    console.log(`   wallet ${w.id} ${w.chain}: ${JSON.stringify(w.balances ?? "(no balances field)")}`);
  }
  // --- merchant bank ---
  let ext = s.merchant_external_account_id;
  if (!ext) {
    console.log("→ Creating merchant external account (fake US bank)…");
    const created = await client.createExternalAccount(s.merchant_customer_id, {
      currency: "usd",
      account_type: "us",
      bank_name: "Demo Bank of Texas",
      account_owner_name: "Sarena Games LLC",
      account_owner_type: "business",
      business_name: "Sarena Games LLC",
      account: { account_number: "123456789012", routing_number: "121000248", checking_or_savings: "checking" },
      address: { street_line_1: MERCHANT_ADDRESS.street_line_1, city: MERCHANT_ADDRESS.city, state: MERCHANT_ADDRESS.subdivision, postal_code: MERCHANT_ADDRESS.postal_code, country: "USA" },
    });
    ext = created.id;
    writeState({ bridge: { merchant_external_account_id: ext } });
    console.log(`✓ merchant external account: ${ext} (…${created.account?.last_4}, active=${created.active})`);
  } else {
    console.log(`✓ merchant external account already in state: ${ext}`);
  }

  console.log("\nNext: npm run transfer:bridge");
};

main().catch(failBridge);
