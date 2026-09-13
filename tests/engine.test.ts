/** PaymentEngine — ledger truth for the three fates, with mock rails. */
import assert from "node:assert/strict";
import { test } from "node:test";
import type { SettlementRail } from "../packages/core/src/rails.js";
import { PaymentEngine } from "../packages/orchestrator/src/engine.js";
import { AlwaysT1Risk, MockConsumerRail, MockSettlementRail } from "../packages/orchestrator/src/mock-rails.js";

const fresh = () => new PaymentEngine(new MockConsumerRail(), new MockSettlementRail(), new AlwaysT1Risk());
const entries = (e: PaymentEngine, intentId: string) => e.ledger.filter((l) => l.paymentIntentId === intentId);
const sum = (e: PaymentEngine, intentId: string, type: string) =>
  entries(e, intentId).filter((l) => l.type === type).reduce((s, l) => s + l.amount, 0);

test("A: happy path fronts net, then books payout + fee, then replenishes gross", async () => {
  const e = fresh();
  const p = e.createPayment({ merchantId: "m", playerId: "p", amount: 2000 });
  assert.equal(p.feeAmount, 60);
  await e.start(p.id);
  assert.equal(p.status, "fronting");
  assert.equal(p.window, "T1");
  assert.ok(p.astraRoutineId && p.bridgeTransferId, "both rail ids captured");
  assert.equal(sum(e, p.id, "TREASURY_FRONT"), -1940);

  e.onSettlementConfirmed(p.id);
  assert.equal(p.status, "settled");
  assert.equal(sum(e, p.id, "MERCHANT_PAYOUT"), 1940);
  assert.equal(sum(e, p.id, "FEE_ACCRUED"), 60);

  e.onAchCleared(p.id);
  assert.equal(p.status, "replenished");
  assert.equal(sum(e, p.id, "ACH_REPLENISH"), 2000);

  const s = e.summary();
  assert.deepEqual(s, { fronted: 1940, replenished: 2000, feesEarned: 60, lossesAbsorbed: 0, chargebacksAbsorbed: 0 });
});

test("B: return AFTER settlement is a treasury loss; the merchant is never debited", async () => {
  const e = fresh();
  const p = e.createPayment({ merchantId: "m", playerId: "p", amount: 5000 });
  await e.start(p.id);
  e.onSettlementConfirmed(p.id);
  e.onAchReturned(p.id, "R10");
  assert.equal(p.status, "loss_absorbed");
  assert.equal(sum(e, p.id, "LOSS_WRITEOFF"), -4850);
  assert.equal(sum(e, p.id, "MERCHANT_PAYOUT"), 4850, "payout stands");
  assert.ok(entries(e, p.id).every((l) => !(l.type === "MERCHANT_PAYOUT" && l.amount < 0)), "no merchant debit ever");
  assert.equal(e.summary().lossesAbsorbed, 4850);
});

test("B': return BEFORE settlement unwinds cleanly with no loss", async () => {
  const e = fresh();
  const p = e.createPayment({ merchantId: "m", playerId: "p", amount: 5000 });
  await e.start(p.id); // fronting
  e.onAchReturned(p.id, "R01");
  assert.equal(p.status, "returned");
  assert.equal(sum(e, p.id, "LOSS_WRITEOFF"), 0);
  assert.equal(e.summary().lossesAbsorbed, 0);
});

test("C: chargeback after replenishment is absorbed for the gross amount", async () => {
  const e = fresh();
  const p = e.createPayment({ merchantId: "m", playerId: "p", amount: 3500 });
  await e.start(p.id);
  e.onSettlementConfirmed(p.id);
  e.onAchCleared(p.id);
  e.onChargeback(p.id);
  assert.equal(p.status, "charged_back");
  assert.equal(sum(e, p.id, "CHARGEBACK_ABSORBED"), -3500);
  assert.equal(e.summary().chargebacksAbsorbed, 3500);
});

test("the settlement rail receives the intent id and the NET amount", async () => {
  const seen: { paymentIntentId: string; merchantId: string; amount: number }[] = [];
  const spy: SettlementRail = {
    name: "spy",
    async settleToMerchant(p) {
      seen.push(p);
      return { externalId: "t_1" };
    },
  };
  const e = new PaymentEngine(new MockConsumerRail(), spy, new AlwaysT1Risk());
  const p = e.createPayment({ merchantId: "merch_x", playerId: "p", amount: 1999 });
  await e.start(p.id);
  assert.deepEqual(seen, [{ paymentIntentId: p.id, merchantId: "merch_x", amount: 1939 }]);
  assert.equal(p.bridgeTransferId, "t_1");
});

test("unknown intents and out-of-order events are rejected", async () => {
  const e = fresh();
  assert.throws(() => e.onSettlementConfirmed("nope"), /Unknown payment intent/);
  const p = e.createPayment({ merchantId: "m", playerId: "p", amount: 1000 });
  assert.throws(() => e.onSettlementConfirmed(p.id), /Illegal payment transition/); // not started yet
});
