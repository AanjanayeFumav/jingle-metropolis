/** Crypto stays invisible: the merchant view, the player checkout, and the DTO layer must never use these words. */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { STATUS_LABEL } from "../apps/api/src/view.js";

const BANNED = /\b(usdc|usdb|usdt|stablecoins?|wallets?|on-chain|onchain|blockchain|crypto|solana|monad|tokens?|chain)\b/i;

test("merchant and player views contain no crypto vocabulary and carry the sandbox disclaimer", () => {
  for (const file of ["apps/api/public/index.html", "apps/api/public/checkout.html", "apps/api/public/merchant-setup.html"]) {
    const html = readFileSync(file, "utf8");
    const hit = html.match(BANNED);
    assert.equal(hit, null, `banned word in ${file}: ${hit?.[0]}`);
    assert.match(html, /Sandbox/i);
    assert.match(html, /simulated funds/);
  }
});

test("DTO layer and status labels contain no crypto vocabulary", () => {
  const src = readFileSync("apps/api/src/view.ts", "utf8");
  const hit = src.match(BANNED);
  assert.equal(hit, null, `banned word in view.ts: ${hit?.[0]}`);
  for (const label of Object.values(STATUS_LABEL)) assert.doesNotMatch(label, BANNED);
});

test("the operator console is the only view allowed to say Monad", () => {
  assert.match(readFileSync("apps/api/public/ops.html", "utf8"), /Monad/);
});
