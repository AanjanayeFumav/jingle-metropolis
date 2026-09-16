/** Snapshot round-trip: a restarted process sees the same payments, ledger, facts, and can keep reconciling. */
import assert from "node:assert/strict";
import { existsSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { PaymentEngine } from "../packages/orchestrator/src/engine.js";
import { AlwaysT1Risk, MockConsumerRail, MockSettlementRail } from "../packages/orchestrator/src/mock-rails.js";
import { Reconciler } from "../apps/api/src/reconcile.js";
import { loadSnapshot, restore, saveSnapshot } from "../apps/api/src/store.js";

const fresh = () => new PaymentEngine(new MockConsumerRail(), new MockSettlementRail(), new AlwaysT1Risk());

test("save → load → restore preserves everything and reconciliation continues", async () => {
  const engine = fresh();
  const rec = new Reconciler(engine);
  const p = engine.createPayment({ merchantId: "m", playerId: "p", amount: 1999 });
  await engine.start(p.id);
  rec.recordBridgeTransfer(p.id, { id: "bt", state: "payment_processed" });
  rec.reconcile(p.id);
  assert.equal(p.status, "settled");

  const path = join(tmpdir(), `fumav-snap-${process.pid}-${Date.now()}.json`);
  try {
    saveSnapshot(path, engine, rec, new Set(["wh_1"]));
    assert.ok(existsSync(path));
    assert.ok(!existsSync(`${path}.tmp`), "atomic rename leaves no temp file");

    const engine2 = fresh();
    const rec2 = new Reconciler(engine2);
    const seen2 = new Set<string>();
    const snap = loadSnapshot(path);
    assert.ok(snap);
    restore(engine2, rec2, snap, seen2);

    assert.deepEqual([...engine2.intents.values()], [...engine.intents.values()]);
    assert.deepEqual(engine2.ledger, engine.ledger);
    assert.deepEqual(engine2.summary(), engine.summary());
    assert.deepEqual(rec2.facts.get(p.id), rec.facts.get(p.id));
    assert.ok(seen2.has("wh_1"));

    rec2.recordAstraTransfer(p.id, { id: "at", status: "processed" });
    assert.deepEqual(rec2.reconcile(p.id), ["replenished"]);
    assert.equal(engine2.intents.get(p.id)?.status, "replenished");
  } finally {
    if (existsSync(path)) unlinkSync(path);
  }
});

test("missing snapshot is null, not an error", () => {
  assert.equal(loadSnapshot(join(tmpdir(), "definitely-not-there.json")), null);
});
