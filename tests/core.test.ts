/**
 * Core invariants — the TRANSITIONS table IS the product, so these tests pin it down.
 * Run: npm test   (node's built-in runner via tsx; no keys, no network)
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { type PaymentIntentStatus, TRANSITIONS, assertTransition, canTransition } from "../packages/core/src/index.js";
import { PRICING, feeFor } from "../packages/orchestrator/src/engine.js";
import { usdFromCents } from "../packages/astra/src/client.js";

const walk = (path: PaymentIntentStatus[]) => {
  for (let i = 0; i < path.length - 1; i++) {
    assert.ok(canTransition(path[i], path[i + 1]), `${path[i]} → ${path[i + 1]} should be legal`);
  }
};

test("T1 happy path: created → ach_initiated → fronting → settled → replenished", () => {
  walk(["created", "ach_initiated", "fronting", "settled", "replenished"]);
});

test("T4 happy path: created → ach_initiated → holding → settled", () => {
  walk(["created", "ach_initiated", "holding", "settled"]);
});

test("clean unwind: a return before settlement never becomes a loss", () => {
  walk(["created", "ach_initiated", "fronting", "returned"]);
  walk(["created", "ach_initiated", "holding", "returned"]);
  assert.ok(!canTransition("settled", "returned"), "once settled, a return is a loss event, not a clean unwind");
});

test("the two loss states are only reachable after the merchant was paid", () => {
  const reachLoss = (Object.keys(TRANSITIONS) as PaymentIntentStatus[]).filter((s) => canTransition(s, "loss_absorbed"));
  const reachCb = (Object.keys(TRANSITIONS) as PaymentIntentStatus[]).filter((s) => canTransition(s, "charged_back"));
  assert.deepEqual(reachLoss, ["settled"]);
  assert.deepEqual(reachCb.sort(), ["replenished", "settled"]);
});

test("terminal states have no exits", () => {
  for (const s of ["returned", "loss_absorbed", "charged_back"] as const) {
    assert.deepEqual(TRANSITIONS[s], [], `${s} must be terminal`);
  }
});

test("illegal transitions throw", () => {
  assert.throws(() => assertTransition("created", "settled"), /Illegal payment transition/);
  assert.throws(() => assertTransition("fronting", "holding"));
  assert.throws(() => assertTransition("returned", "created"));
});

test("pricing is locked at 3% with a 35¢ floor", () => {
  assert.equal(PRICING.rate, 0.03);
  assert.equal(PRICING.floorCents, 35);
  assert.equal(feeFor(1999, PRICING), 60); // $19.99 → 59.97¢ → 60¢
  assert.equal(feeFor(10000, PRICING), 300); // $100 → $3.00
  assert.equal(feeFor(500, PRICING), 35); // $5 → 15¢ → floor
  assert.equal(feeFor(1166, PRICING), 35); // 34.98¢ → floor wins
  assert.equal(feeFor(1200, PRICING), 36); // 36¢ → rate wins
  assert.equal(feeFor(0, PRICING), 35); // floor applies even at zero
});

test("cents → USD conversion happens only at the Astra boundary and is exact", () => {
  assert.equal(usdFromCents(1999), 19.99);
  assert.equal(usdFromCents(35), 0.35);
  assert.equal(usdFromCents(100), 1);
  assert.throws(() => usdFromCents(19.5));
  assert.throws(() => usdFromCents(-1));
});
