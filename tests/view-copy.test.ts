/** Crypto stays invisible: the merchant view and its DTO layer must never use these words. */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { STATUS_LABEL } from "../apps/api/src/view.js";

const BANNED = /\b(usdc|usdb|usdt|stablecoins?|wallets?|on-chain|onchain|blockchain|crypto|solana|tokens?|chain)\b/i;

test("index.html contains no crypto vocabulary and carries the sandbox disclaimer", () => {
  const html = readFileSync("apps/api/public/index.html", "utf8");
  const hit = html.match(BANNED);
  assert.equal(hit, null, `banned word in view: ${hit?.[0]}`);
  assert.match(html, /Sandbox/);
  assert.match(html, /simulated funds/);
});

test("DTO layer and status labels contain no crypto vocabulary", () => {
  const src = readFileSync("apps/api/src/view.ts", "utf8");
  const hit = src.match(BANNED);
  assert.equal(hit, null, `banned word in view.ts: ${hit?.[0]}`);
  for (const label of Object.values(STATUS_LABEL)) assert.doesNotMatch(label, BANNED);
});
