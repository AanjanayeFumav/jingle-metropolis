/**
 * One command: `npm run dev` (MOCK=true for keyless) starts the API, the pollers, and serves the merchant view.
 * Live mode needs .env keys and the ids in .fumav-state.json from Sessions 1 and 2.
 */
import "dotenv/config";
import { resolve } from "node:path";
import { createApp } from "./app.js";
import { startPollers } from "./pollers.js";
import { loadSnapshot, restore } from "./store.js";
import { buildRuntime } from "./wiring.js";

const port = Number(process.env.PORT ?? 3100);
const rt = buildRuntime();
const snapshotPath = rt.mode === "live" ? resolve(process.cwd(), ".fumav-payments.json") : undefined;

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
  rt.mode === "mock" ? { bridgeMs: 2_000, astraMs: 5_000 } : { bridgeMs: 10_000, astraMs: 60_000 },
);

const server = app.listen(port, () => {
  console.log(`\nFumav API + merchant view  [${rt.mode.toUpperCase()}]`);
  console.log(`  view:     http://localhost:${port}/`);
  console.log(`  api:      http://localhost:${port}/api/payments`);
  console.log(`  webhook:  POST /webhooks/astra  (register https://<tunnel-host>/webhooks/astra in the Astra dashboard)`);
  if (rt.mode === "live") console.log(`  tunnel:   npm run tunnel   (needs NGROK_DOMAIN in .env)`);
  console.log(`  pay:      npm run pay -- --amount 1999\n`);
});

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    stop();
    ctx.save();
    server.close(() => process.exit(0));
  });
}
