/**
 * One command: `npm run dev` (MOCK=true, keyless) or `npm run dev:monad` (MONAD=true, live settlement on Monad)
 * starts the API, the pollers, and serves the three views: /checkout (player), / (merchant), /ops (operator).
 */
import "dotenv/config";
import { resolve } from "node:path";
import { createApp } from "./app.js";
import { startPollers } from "./pollers.js";
import { loadSnapshot, restore } from "./store.js";
import { buildRuntime } from "./wiring.js";

const port = Number(process.env.PORT ?? 3100);
const rt = buildRuntime();
const snapshotPath =
  rt.mode === "live" ? resolve(process.cwd(), ".fumav-payments.json") : rt.mode === "monad" ? resolve(process.cwd(), ".jingle-payments.json") : undefined;

const { app, ctx } = createApp(rt, { webhookSecret: process.env.ASTRA_CLIENT_SECRET ?? "", snapshotPath });

if (snapshotPath) {
  const snap = loadSnapshot(snapshotPath);
  if (snap) {
    restore(rt.engine, rt.reconciler, snap, ctx.seenWebhookIds);
    console.log(`[boot] restored ${snap.intents.length} payment(s), ${snap.ledger.length} ledger entries from ${snapshotPath}`);
  }
}
rt.reconciler.reconcileAll();
ctx.save();

const stop = startPollers(
  rt,
  ctx,
  rt.mode === "mock" ? { bridgeMs: 2_000, astraMs: 5_000 } : rt.mode === "monad" ? { bridgeMs: 700, astraMs: 4_000 } : { bridgeMs: 10_000, astraMs: 60_000 },
);

const server = app.listen(port, () => {
  console.log(`\nJingle  [${rt.mode.toUpperCase()}]`);
  console.log(`  player checkout:   http://localhost:${port}/checkout`);
  console.log(`  merchant view:     http://localhost:${port}/`);
  console.log(`  operator console:  http://localhost:${port}/ops`);
  console.log(`  api:               http://localhost:${port}/api/payments`);
  if (rt.chain) console.log(`  settlement:        ${rt.chain.addressUrl(rt.chain.deployment.settlement)}`);
  console.log(`  pay from a shell:  npm run pay -- --amount 1999\n`);
});

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    stop();
    ctx.save();
    server.close(() => process.exit(0));
  });
}
