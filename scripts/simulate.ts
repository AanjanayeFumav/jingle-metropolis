/**
 * Simulate the business model: three payments, three fates.
 *   A — happy path (front → settle → replenish)
 *   B — ACH returns AFTER settlement (treasury absorbs: the 4 bps)
 *   C — Reg E chargeback after replenishment (guarantee invoked)
 * Run: npm run simulate   (no keys, no network)
 */
import { PaymentEngine, PRICING } from "../packages/orchestrator/src/engine.js";
import { AlwaysT1Risk, MockConsumerRail, MockSettlementRail } from "../packages/orchestrator/src/mock-rails.js";

const usd = (cents: number) => `$${(cents / 100).toFixed(2)}`;

const engine = new PaymentEngine(new MockConsumerRail(), new MockSettlementRail(), new AlwaysT1Risk(), PRICING);

const main = async () => {
  // A: $20 skin purchase — happy path
  const a = engine.createPayment({ merchantId: "merch_sarena", playerId: "player_1", amount: 2000 });
  await engine.start(a.id);
  engine.onSettlementConfirmed(a.id);
  engine.onAchCleared(a.id);

  // B: $50 deposit — ACH bounces AFTER we already paid the merchant
  const b = engine.createPayment({ merchantId: "merch_sarena", playerId: "player_2", amount: 5000 });
  await engine.start(b.id);
  engine.onSettlementConfirmed(b.id);
  engine.onAchReturned(b.id, "R10");

  // C: $35 deposit — clears fine, player disputes 3 weeks later
  const c = engine.createPayment({ merchantId: "merch_betty", playerId: "player_3", amount: 3500 });
  await engine.start(c.id);
  engine.onSettlementConfirmed(c.id);
  engine.onAchCleared(c.id);
  engine.onChargeback(c.id);

  console.log("\n════ PAYMENTS ════");
  for (const p of engine.intents.values()) {
    console.log(
      `${p.id}  ${usd(p.amount).padStart(7)}  fee ${usd(p.feeAmount).padStart(6)}  [${p.window}]  → ${p.status}`,
    );
  }

  console.log("\n════ LEDGER (the dashboard reads this) ════");
  for (const e of engine.ledger) {
    console.log(`${e.occurredAt.slice(11, 19)}  ${e.type.padEnd(20)} ${usd(e.amount).padStart(9)}  ${e.memo ?? ""}`);
  }

  const s = engine.summary();
  console.log("\n════ TREASURY P&L (the float model's seed) ════");
  console.log(`fronted:              ${usd(s.fronted)}`);
  console.log(`replenished:          ${usd(s.replenished)}`);
  console.log(`fees earned:          ${usd(s.feesEarned)}`);
  console.log(`losses absorbed:      ${usd(s.lossesAbsorbed)}   ← the 4 bps, structurally capped by risk screening`);
  console.log(`chargebacks absorbed: ${usd(s.chargebacksAbsorbed)}   ← the guarantee, priced into the take rate`);
  console.log(`\nMerchants were never debited in scenarios B or C. That's the product.`);
};

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
