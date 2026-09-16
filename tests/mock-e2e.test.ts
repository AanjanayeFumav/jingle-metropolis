/** The whole API in MOCK mode on port 0: a payment reaches replenished through the pollers; webhooks verify + dedupe. */
import assert from "node:assert/strict";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { createApp } from "../apps/api/src/app.js";
import { signAstraPayload } from "../apps/api/src/astra-verify.js";
import { startPollers } from "../apps/api/src/pollers.js";
import { buildRuntime } from "../apps/api/src/wiring.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test("mock end-to-end: pay → fronting → settled → replenished; webhooks 401/200/dedupe", async () => {
  const rt = buildRuntime({ MOCK: "true" }, { bridgeStepMs: 30, astraClearMs: 200 });
  const { app, ctx } = createApp(rt, { webhookSecret: "test-secret" });
  const stop = startPollers(rt, ctx, { bridgeMs: 25, astraMs: 40 });
  const server = app.listen(0);
  await once(server, "listening");
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const json = async (path: string, init?: RequestInit) => {
    const res = await fetch(base + path, init);
    return { status: res.status, body: (await res.json()) as any };
  };

  try {
    const bad = await json("/api/payments", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ amount: 19.99 }) });
    assert.equal(bad.status, 400);

    const created = await json("/api/payments", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ amount: 1999 }) });
    assert.equal(created.status, 201);
    const p = created.body;
    assert.equal(p.status, "fronting");
    assert.equal(p.net, 1939);
    assert.match(p.bankDebit.routineId, /^mock_routine_/);
    assert.match(p.settlement.transferId, /^mock_transfer_/);

    let cur = p;
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline && cur.status !== "replenished") {
      await sleep(30);
      cur = (await json(`/api/payments/${p.id}`)).body;
    }
    assert.equal(cur.status, "replenished", `stuck at ${cur.status}: ${JSON.stringify(cur)}`);
    assert.equal(cur.settlement.label, "Delivered");
    assert.equal(cur.bankDebit.transferStatus, "processed");

    const ledger = (await json("/api/ledger")).body.entries.map((e: { type: string }) => e.type).sort();
    assert.deepEqual(ledger, ["ACH_REPLENISH", "FEE_ACCRUED", "MERCHANT_PAYOUT", "TREASURY_FRONT"]);

    const summary = (await json("/api/summary")).body;
    assert.equal(summary.counts.paidOut, 1);
    assert.equal(summary.operator.feesEarned, 60);

    // Webhooks: unsigned → 401; signed → 200 and handled; same webhook_id again → 200 but not re-handled.
    const payload = { webhook_type: "transfer_updated", webhook_id: "wh_e2e_1", user_id: "u_1", resource_id: `mock_ach_${p.bankDebit.routineId}` };
    const body = JSON.stringify(payload);
    const unsigned = await json("/webhooks/astra", { method: "POST", headers: { "Content-Type": "application/json" }, body });
    assert.equal(unsigned.status, 401);
    const sig = signAstraPayload(payload, "test-secret");
    const signed = await json("/webhooks/astra", { method: "POST", headers: { "Content-Type": "application/json", "Astra-Verification": sig }, body });
    assert.equal(signed.status, 200);
    const dup = await json("/webhooks/astra", { method: "POST", headers: { "Content-Type": "application/json", "Astra-Verification": sig }, body });
    assert.equal(dup.status, 200);
    await sleep(60);
    assert.equal(ctx.webhooksRejected, 1);
    assert.equal(ctx.webhooksHandled, 1);
    assert.ok(ctx.lastWebhookAt);

    const health = (await json("/api/health")).body;
    assert.equal(health.mode, "mock");
    assert.ok(health.pollers.bridge > 0 && health.pollers.astra > 0);

    const html = await fetch(base + "/").then((r) => r.text());
    assert.match(html, /Merchant settlement/);
  } finally {
    stop();
    server.close();
  }
});
