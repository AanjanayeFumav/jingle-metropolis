/** Privy merchant payout accounts: keyless mock client, idempotent API, resolver override, REST request shape. */
import assert from "node:assert/strict";
import { once } from "node:events";
import { readFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { createApp } from "../apps/api/src/app.js";
import { buildRuntime, DEMO_MERCHANT_ID } from "../apps/api/src/wiring.js";
import { MockPrivyClient, RestPrivyClient, privyClientFor } from "../packages/privy/src/client.js";

test("mock Privy client creates a deterministic account per key", async () => {
  const c = new MockPrivyClient();
  const a = await c.createWallet({ idempotencyKey: "jingle-payout-merch_starfall" });
  const b = await c.createWallet({ idempotencyKey: "jingle-payout-merch_starfall" });
  const other = await c.createWallet({ idempotencyKey: "jingle-payout-merch_other" });
  assert.deepEqual(a, b);
  assert.notEqual(a.address, other.address);
  assert.match(a.address, /^0x[0-9a-fA-F]{40}$/);
  assert.equal(a.chainType, "ethereum");
});

test("privyClientFor stays on the mock without keys or in MOCK mode", () => {
  assert.equal(privyClientFor({}, { mock: false }).provider, "privy-mock");
  assert.equal(privyClientFor({ PRIVY_APP_ID: "a", PRIVY_APP_SECRET: "s" }, { mock: true }).provider, "privy-mock");
  assert.equal(privyClientFor({ PRIVY_APP_ID: "a", PRIVY_APP_SECRET: "s" }, { mock: false }).provider, "privy");
});

test("REST client sends the documented Create wallet request", async () => {
  let seen: { url: string; init: RequestInit } | undefined;
  const fakeFetch = (async (url: string, init: RequestInit) => {
    seen = { url, init };
    return new Response(JSON.stringify({ id: "w1", address: "0xc71daff64ecc6fac9de76c681092634592456459", chain_type: "ethereum" }), { status: 200 });
  }) as unknown as typeof fetch;
  const c = new RestPrivyClient({ appId: "app_1", appSecret: "sec", fetch: fakeFetch });
  const w = await c.createWallet({ idempotencyKey: "k1" });
  assert.equal(seen!.url, "https://api.privy.io/v1/wallets");
  assert.equal(seen!.init.method, "POST");
  const h = seen!.init.headers as Record<string, string>;
  assert.equal(h.Authorization, "Basic " + Buffer.from("app_1:sec").toString("base64"));
  assert.equal(h["privy-app-id"], "app_1");
  assert.equal(h["privy-idempotency-key"], "k1");
  assert.deepEqual(JSON.parse(String(seen!.init.body)), { chain_type: "ethereum" });
  assert.equal(w.address, "0xc71dAFF64eCc6FAc9DE76C681092634592456459");
});

test("payout account API: 404 before, 201 on create, idempotent second POST, resolveMerchant returns the override", async () => {
  const rt = buildRuntime({ MOCK: "true" });
  assert.throws(() => rt.resolveMerchant(DEMO_MERCHANT_ID));
  const { app } = createApp(rt, { webhookSecret: "x" });
  const server = app.listen(0);
  await once(server, "listening");
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const post = (email: string) =>
    fetch(`${base}/api/merchants/${DEMO_MERCHANT_ID}/payout-account`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email }) });
  try {
    assert.equal((await fetch(`${base}/api/merchants/${DEMO_MERCHANT_ID}`)).status, 404);
    assert.equal((await post("not-an-email")).status, 400);
    const first = await post("finance@starfall.studio");
    assert.equal(first.status, 201);
    const a = (await first.json()) as any;
    assert.equal(a.merchantId, DEMO_MERCHANT_ID);
    assert.equal(a.provider, "privy");
    assert.equal(a.email, "finance@starfall.studio");
    assert.match(a.address, /^0x[0-9a-fA-F]{40}$/);
    assert.ok(a.privyWalletId);
    const second = await post("someone-else@starfall.studio");
    assert.equal(second.status, 200);
    assert.deepEqual(await second.json(), a);
    assert.deepEqual(await (await fetch(`${base}/api/merchants/${DEMO_MERCHANT_ID}`)).json(), a);
    assert.equal(rt.resolveMerchant(DEMO_MERCHANT_ID), a.address);
    const setup = await fetch(`${base}/merchant/setup`);
    assert.equal(setup.status, 200);
    assert.match(await setup.text(), /Set up payouts/);
  } finally {
    server.close();
  }
});

test("merchant setup page carries no crypto vocabulary", () => {
  const html = readFileSync("apps/api/public/merchant-setup.html", "utf8");
  assert.equal(html.match(/\b(usdc|usdb|usdt|stablecoins?|wallets?|on-chain|onchain|blockchain|crypto|solana|monad|tokens?|chain)\b/i), null);
  assert.match(html, /simulated funds/);
});
