/**
 * Snapshot persistence for one API process: intents, ledger, rail facts, seen webhook ids.
 * Written after every mutation (atomic rename), loaded at boot. Restores straight into the engine's
 * public `intents` / `ledger`; the engine itself stays storage-agnostic. Live mode only; mock is in-memory.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { LedgerEntry, PaymentIntent } from "../../../packages/core/src/index.js";
import type { PaymentEngine } from "../../../packages/orchestrator/src/engine.js";
import type { RailFacts, Reconciler } from "./reconcile.js";

export interface Snapshot {
  version: 1;
  savedAt: string;
  intents: PaymentIntent[];
  ledger: LedgerEntry[];
  facts: Record<string, RailFacts>;
  seenWebhookIds: string[];
}

const MAX_SEEN = 1000;

export function loadSnapshot(path: string): Snapshot | null {
  if (!existsSync(path)) return null;
  const snap = JSON.parse(readFileSync(path, "utf8")) as Snapshot;
  if (snap.version !== 1) throw new Error(`unsupported snapshot version ${String(snap.version)} at ${path}`);
  return snap;
}

export function restore(engine: PaymentEngine, reconciler: Reconciler, snap: Snapshot, seen: Set<string>): void {
  for (const intent of snap.intents) engine.intents.set(intent.id, intent);
  engine.ledger.push(...snap.ledger);
  for (const [id, f] of Object.entries(snap.facts)) reconciler.facts.set(id, f);
  for (const id of snap.seenWebhookIds) seen.add(id);
}

export function saveSnapshot(path: string, engine: PaymentEngine, reconciler: Reconciler, seen: Set<string>): void {
  const snap: Snapshot = {
    version: 1,
    savedAt: new Date().toISOString(),
    intents: [...engine.intents.values()],
    ledger: engine.ledger,
    facts: Object.fromEntries(reconciler.facts),
    seenWebhookIds: [...seen].slice(-MAX_SEEN),
  };
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(snap, null, 2) + "\n");
  renameSync(tmp, path);
}
