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

test("Privy viem account: eth_signTransaction request shape, and the returned raw tx is what gets broadcast", async () => {
  const { privateKeyToAccount } = await import("viem/accounts");
  const { parseTransaction, recoverTransactionAddress } = await import("viem");
  const { privyAccount, toPrivyTransaction } = await import("../packages/privy/src/viem-account.js");
  // Stand-in for Privy: signs the params it receives with a local key, so the round trip checks our field mapping.
  const key = privateKeyToAccount("0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d");
  let body: any;
  const fake = {
    async rpc<T>(walletId: string, b: { method: string; params: any }): Promise<T> {
      assert.equal(walletId, "wal_1");
      body = b;
      const t = b.params.transaction;
      const signed = await key.signTransaction({
        type: "eip1559", chainId: t.chain_id, nonce: t.nonce, to: t.to, data: t.data, value: BigInt(t.value),
        gas: BigInt(t.gas_limit), maxFeePerGas: BigInt(t.max_fee_per_gas), maxPriorityFeePerGas: BigInt(t.max_priority_fee_per_gas),
      });
      return { method: "eth_signTransaction", data: { signed_transaction: signed, encoding: "rlp" } } as T;
    },
  };
  const acct = privyAccount(fake, "wal_1", key.address);
  const tx = { chainId: 10143, nonce: 7, to: "0xa655ef5323a95cceaf81907dd945720cab2de999" as const, data: "0x1234" as const, value: 0n, gas: 90_000n, maxFeePerGas: 60_000_000_000n, maxPriorityFeePerGas: 2_000_000_000n };
  const raw = await acct.signTransaction(tx);
  assert.equal(body.method, "eth_signTransaction");
  assert.deepEqual(body.params.transaction, toPrivyTransaction(tx, key.address));
  assert.equal(body.params.transaction.type, 2);
  assert.equal(body.params.transaction.chain_id, 10143);
  assert.equal(body.params.transaction.gas_limit, "0x15f90");
  const parsed = parseTransaction(raw);
  assert.equal(parsed.chainId, 10143);
  assert.equal(parsed.nonce, 7);
  assert.equal(await recoverTransactionAddress({ serializedTransaction: raw as any }), key.address);
});

test("walletClientFor: raw key by default, Privy only when TREASURY_SIGNER=privy and its ids are set", async () => {
  const { walletClientFor } = await import("../packages/monad/src/clients.js");
  const pk = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";
  assert.equal(walletClientFor({ MONAD_PRIVATE_KEY: pk }).account.type, "local");
  assert.throws(() => walletClientFor({ MONAD_PRIVATE_KEY: pk, TREASURY_SIGNER: "privy" }), /PRIVY_TREASURY_WALLET_ID/);
  const c = walletClientFor({ TREASURY_SIGNER: "privy", PRIVY_APP_ID: "a", PRIVY_APP_SECRET: "s", PRIVY_TREASURY_WALLET_ID: "w", PRIVY_TREASURY_ADDRESS: "0xc71dAFF64eCc6FAc9DE76C681092634592456459" });
  assert.equal(c.account.address, "0xc71dAFF64eCc6FAc9DE76C681092634592456459");
});
