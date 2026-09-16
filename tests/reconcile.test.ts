/** Reconciler over a real PaymentEngine with mock rails — facts arrive in any order, ledger stays truthful. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { PaymentEngine } from "../packages/orchestrator/src/engine.js";
import { AlwaysT1Risk, MockConsumerRail, MockSettlementRail } from "../packages/orchestrator/src/mock-rails.js";
import { Reconciler } from "../apps/api/src/reconcile.js";

async function fronted(amount = 2000) {
  const engine = new PaymentEngine(new MockConsumerRail(), new MockSettlementRail(), new AlwaysT1Risk());
  const rec = new Reconciler(engine);
  const p = engine.createPayment({ merchantId: "m", playerId: "p", amount });
  await engine.start(p.id);
  assert.equal(p.status, "fronting");
  return { engine, rec, p };
}
const bridge = (state: string) => ({ id: "bt_1", state });
const astra = (status: string, extra: Record<string, unknown> = {}) => ({ id: "at_1", status, ...extra });
const types = (engine: PaymentEngine, id: string) => engine.ledger.filter((l) => l.paymentIntentId === id).map((l) => l.type);

test("Bridge processed while fronting → settled with payout + fee", async () => {
  const { engine, rec, p } = await fronted();
  rec.recordBridgeTransfer(p.id, bridge("funds_received"));
  assert.deepEqual(rec.reconcile(p.id), []);
  assert.equal(p.status, "fronting");
  rec.recordBridgeTransfer(p.id, bridge("payment_processed"));
  assert.deepEqual(rec.reconcile(p.id), ["settled"]);
  assert.deepEqual(types(engine, p.id), ["TREASURY_FRONT", "MERCHANT_PAYOUT", "FEE_ACCRUED"]);
});

test("Astra processed arriving BEFORE Bridge processed is deferred, then applied", async () => {
  const { engine, rec, p } = await fronted();
  rec.recordAstraTransfer(p.id, astra("processed"));
  assert.deepEqual(rec.reconcile(p.id), []); // fronting → replenished is illegal; fact waits
  assert.equal(p.status, "fronting");
  rec.recordBridgeTransfer(p.id, bridge("payment_processed"));
  assert.deepEqual(rec.reconcile(p.id), ["settled", "replenished"]);
  assert.deepEqual(types(engine, p.id), ["TREASURY_FRONT", "MERCHANT_PAYOUT", "FEE_ACCRUED", "ACH_REPLENISH"]);
});

test("ACH failed while fronting → returned, no loss", async () => {
  const { engine, rec, p } = await fronted();
  rec.recordAstraTransfer(p.id, astra("failed", { failure_reason: "R01 insufficient funds" }));
  assert.deepEqual(rec.reconcile(p.id), ["returned"]);
  assert.ok(!types(engine, p.id).includes("LOSS_WRITEOFF"));
  assert.equal(engine.ledger.find((l) => l.type === "ACH_RETURN")?.memo, "return code R01 insufficient funds");
});

test("ACH failed after settled → loss_absorbed; merchant untouched", async () => {
  const { engine, rec, p } = await fronted(5000);
  rec.recordBridgeTransfer(p.id, bridge("payment_processed"));
  rec.reconcile(p.id);
  rec.recordAstraTransfer(p.id, astra("failed", { failure_reason: "R10" }));
  assert.deepEqual(rec.reconcile(p.id), ["loss_absorbed"]);
  assert.equal(engine.summary().lossesAbsorbed, 4850);
  assert.equal(engine.ledger.filter((l) => l.type === "MERCHANT_PAYOUT").reduce((s, l) => s + l.amount, 0), 4850);
});

test("routine failed (no transfer ever) counts as a return", async () => {
  const { rec, p } = await fronted();
  rec.recordAstraRoutine(p.id, { id: "rt_1", status: "failed", type: "one-time" });
  assert.deepEqual(rec.reconcile(p.id), ["returned"]);
});

test("Bridge failure state → flag only, status and ledger unchanged", async () => {
  const { engine, rec, p } = await fronted();
  rec.recordBridgeTransfer(p.id, bridge("undeliverable"));
  assert.deepEqual(rec.reconcile(p.id), []);
  assert.equal(p.status, "fronting");
  assert.equal(rec.facts.get(p.id)?.settlementFailed, true);
  assert.deepEqual(types(engine, p.id), ["TREASURY_FRONT"]);
});

test("chargeback after replenished → charged_back; harmless dispute statuses do nothing", async () => {
  const { engine, rec, p } = await fronted(3500);
  rec.recordBridgeTransfer(p.id, bridge("payment_processed"));
  rec.recordAstraTransfer(p.id, astra("processed", { chargeback: { status: "Not Disputed" } }));
  assert.deepEqual(rec.reconcile(p.id), ["settled", "replenished"]);
  rec.recordAstraTransfer(p.id, astra("processed", { chargeback: { status: "Open" } }));
  assert.deepEqual(rec.reconcile(p.id), ["charged_back"]);
  assert.equal(engine.summary().chargebacksAbsorbed, 3500);
});

test("reconcile is idempotent and tolerates unknown intents", async () => {
  const { engine, rec, p } = await fronted();
  rec.recordBridgeTransfer(p.id, bridge("payment_processed"));
  rec.recordAstraTransfer(p.id, astra("processed"));
  rec.reconcile(p.id);
  const before = engine.ledger.length;
  assert.deepEqual(rec.reconcile(p.id), []);
  assert.deepEqual(rec.reconcile("nope"), []);
  assert.equal(engine.ledger.length, before);
  assert.equal(p.status, "replenished");
});
