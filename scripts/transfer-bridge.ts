/**
 * Session 2 step 4 — the acceptance criterion:
 * treasury wallet → merchant bank (ACH), on_behalf_of the merchant, driven through BridgeSettlementRail
 * with a genuine Fumav PaymentIntent (net of fee).
 * Run: npm run transfer:bridge [-- --amount 1999]
 */
import { BridgeApiError } from "../packages/bridge/src/client.js";
import { BridgeSettlementRail } from "../packages/bridge/src/rail.js";
import { PaymentEngine } from "../packages/orchestrator/src/engine.js";
import { AlwaysT1Risk, MockConsumerRail } from "../packages/orchestrator/src/mock-rails.js";
import { argValue } from "./_astra.js";
import { bridgeFromEnv, failBridge } from "./_bridge.js";
import { readState, writeState } from "./_state.js";

const client = bridgeFromEnv();

const main = async () => {
  const s = readState().bridge ?? {};
  const missing = [
    !s.treasury_wallet_id && "treasury_wallet_id (setup:bridge)",
    !s.merchant_customer_id && "merchant_customer_id (customers:bridge)",
    !s.merchant_external_account_id && "merchant_external_account_id (setup:bridge)",
  ].filter(Boolean);
  if (missing.length) {
    console.error("✗ Missing state:\n  - " + missing.join("\n  - "));
    process.exit(1);
  }

  const onBehalfOf = argValue("--on-behalf-of") ?? s.merchant_customer_id!;
  const rail = new BridgeSettlementRail({
    client,
    treasuryWalletId: s.treasury_wallet_id!,
    treasuryCurrency: "usdc",
    resolveMerchant: async () => ({ customerId: onBehalfOf, externalAccountId: s.merchant_external_account_id! }),
  });

  // Real engine, real settlement rail, mock consumer rail (Astra leg is Session 1's; wired together in S3).
  const engine = new PaymentEngine(new MockConsumerRail(), rail, new AlwaysT1Risk());
  const amount = Number(argValue("--amount") ?? "1999");
  const intent = engine.createPayment({ merchantId: "merch_sarena", playerId: "player_demo", amount });
  console.log(`→ PaymentIntent ${intent.id}: gross ${intent.amount}¢, fee ${intent.feeAmount}¢, net ${intent.amount - intent.feeAmount}¢`);
  console.log(`→ engine.start → BridgeSettlementRail.settleToMerchant (on_behalf_of ${onBehalfOf})…`);

  try {
    await engine.start(intent.id);
  } catch (err) {
    if (err instanceof BridgeApiError) {
      console.error(`✗ Bridge ${err.status}: ${JSON.stringify(err.body)}`);
      console.error("  If this is an on_behalf_of ownership rejection, retry with: -- --on-behalf-of " + s.fumav_customer_id);
    }
    throw err;
  }
  console.log(`✓ intent ${intent.id} → ${intent.status}; bridgeTransferId=${intent.bridgeTransferId}`);
  writeState({ bridge: { last_transfer_id: intent.bridgeTransferId }, last_intent_id: intent.id });

  const t = await client.getTransfer(intent.bridgeTransferId!);
  console.log("→ GET transfer:", JSON.stringify(t, null, 2));
  console.log("\n→ Ledger:");
  for (const e of engine.ledger) console.log(`   ${e.type.padEnd(16)} ${String(e.amount).padStart(7)}¢  ${e.memo ?? ""}`);
  console.log(`\nAC check: Bridge sandbox dashboard → Transfers should show ${t.id} (${t.state}) for ${t.amount} usd, client_reference_id ${intent.id}`);
};

main().catch(failBridge);
