/** Monad rail units + the dispute trigger end to end in mock mode (no chain needed). */
import assert from "node:assert/strict";
import { once } from "node:events";
import { readFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { createApp } from "../apps/api/src/app.js";
import { startPollers } from "../apps/api/src/pollers.js";
import { buildRuntime } from "../apps/api/src/wiring.js";
import { centsToUnits, unitsToCents } from "../packages/monad/src/clients.js";
import { paymentKey } from "../packages/monad/src/rail.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test("payment id -> bytes32 key is deterministic and distinct", () => {
  assert.equal(paymentKey("pay_abc"), paymentKey("pay_abc"));
  assert.notEqual(paymentKey("pay_abc"), paymentKey("pay_abd"));
  assert.match(paymentKey("pay_abc"), /^0x[0-9a-f]{64}$/);
});

test("cents <-> 6-decimal units round-trip, never floats", () => {
  assert.equal(centsToUnits(1939), 19_390_000n);
  assert.equal(centsToUnits(35), 350_000n);
  assert.equal(unitsToCents(19_390_000n), 1939);
  assert.equal(unitsToCents(centsToUnits(123_456_789)), 123_456_789);
});

test("contract artifacts are committed with ABI + bytecode and expose settle/absorbDispute/fundReserve", () => {
  const art = JSON.parse(readFileSync("contracts/artifacts/JingleSettlement.json", "utf8")) as { abi: { type: string; name?: string }[]; bytecode: string };
  assert.match(art.bytecode, /^0x[0-9a-f]+$/);
  const fns = new Set(art.abi.filter((e) => e.type === "function").map((e) => e.name));
  for (const f of ["settle", "absorbDispute", "fundReserve", "reserve", "settlements"]) assert.ok(fns.has(f), `missing ${f}`);
  const events = new Set(art.abi.filter((e) => e.type === "event").map((e) => e.name));
  for (const e of ["Settled", "DisputeAbsorbed", "ReserveFunded"]) assert.ok(events.has(e), `missing event ${e}`);
});

test("dispute trigger: 409 while in flight, then charged_back with CHARGEBACK_ABSORBED once paid out; merchant payout untouched", async () => {
  const rt = buildRuntime({ MOCK: "true" }, { bridgeStepMs: 20, astraClearMs: 10_000 });
  const { app, ctx } = createApp(rt, { webhookSecret: "x" });
  const stop = startPollers(rt, ctx, { bridgeMs: 20, astraMs: 5_000 });
  const server = app.listen(0);
  await once(server, "listening");
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const json = async (path: string, init?: RequestInit) => {
    const res = await fetch(base + path, init);
    return { status: res.status, body: (await res.json()) as any };
  };
  try {
    const created = await json("/api/payments", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ amount: 1999 }) });
    assert.equal(created.status, 201);
    const id = created.body.id as string;
    const early = await json(`/api/payments/${id}/dispute`, { method: "POST" });
    assert.equal(early.status, 409);

    let cur = created.body;
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline && cur.status !== "settled") {
      await sleep(25);
      cur = (await json(`/api/payments/${id}`)).body;
    }
    assert.equal(cur.status, "settled");

    const disputed = await json(`/api/payments/${id}/dispute`, { method: "POST" });
    assert.equal(disputed.status, 200, JSON.stringify(disputed.body));
    assert.equal(disputed.body.status, "charged_back");
    assert.match(disputed.body.dispute.ref, /^mock_dispute_/);

    const types = (await json("/api/ledger")).body.entries.map((e: { type: string }) => e.type).sort();
    assert.deepEqual(types, ["CHARGEBACK_ABSORBED", "FEE_ACCRUED", "MERCHANT_PAYOUT", "TREASURY_FRONT"]);
    const summary = (await json("/api/summary")).body;
    assert.equal(summary.operator.chargebacksAbsorbed, 1999);
    assert.equal(summary.counts.paidOut, 1); // the merchant's payout is still counted as paid

    const again = await json(`/api/payments/${id}/dispute`, { method: "POST" });
    assert.equal(again.status, 409); // a payment can only be disputed once

    const ops = (await json("/api/ops")).body;
    assert.equal(ops.merchantName, "Starfall Studios");
    assert.equal(ops.chain, null);

    for (const p of ["/checkout", "/ops", "/"]) assert.equal((await fetch(base + p)).status, 200, p);
  } finally {
    stop();
    server.close();
  }
});
