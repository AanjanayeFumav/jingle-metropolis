/**
 * One-command demo reset: forget every payment, ledger entry and merchant payout account (the snapshot files). Contracts and balances on
 * Monad are untouched; the next payment starts from a clean console. Stop the API first (it rewrites the snapshot on exit).
 * Run: npm run reset
 */
import { existsSync, unlinkSync } from "node:fs";
import { resolve } from "node:path";

for (const f of [".jingle-payments.json", ".fumav-payments.json", ".jingle-merchants.json"]) {
  const p = resolve(process.cwd(), f);
  if (existsSync(p)) {
    unlinkSync(p);
    console.log(`✓ removed ${f}`);
  }
}
console.log("clean. start again with: npm run dev:monad");
