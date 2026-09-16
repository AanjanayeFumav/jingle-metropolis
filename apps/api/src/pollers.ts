/**
 * Pollers: the fallback (and, for Bridge in sandbox, the only) source of rail facts.
 *  - Bridge: every bridgeMs, intents in `fronting` with a transfer id.
 *  - Astra:  every astraMs, intents with a routine id whose bank-debit outcome is still open.
 * Each tick records facts, reconciles, and saves when anything changed. Errors land on the intent, never crash.
 */
import type { AppContext } from "./app.js";
import type { Runtime } from "./wiring.js";

const ASTRA_OPEN = new Set(["ach_initiated", "fronting", "holding", "settled", "replenished"]);

export interface PollerOptions {
  bridgeMs: number;
  astraMs: number;
}

export function startPollers(rt: Runtime, ctx: AppContext, opts: PollerOptions): () => void {
  const { engine, reconciler, readers } = rt;
  let bridgeBusy = false;
  let astraBusy = false;

  async function bridgeTick(): Promise<void> {
    if (bridgeBusy) return;
    bridgeBusy = true;
    let changed = false;
    try {
      for (const intent of engine.intents.values()) {
        if (intent.status !== "fronting" || !intent.bridgeTransferId) continue;
        try {
          const t = await readers.bridgeTransfer(intent.bridgeTransferId);
          const before = reconciler.facts.get(intent.id)?.bridgeState;
          reconciler.recordBridgeTransfer(intent.id, t);
          const applied = reconciler.reconcile(intent.id);
          if (before !== t.state || applied.length) {
            changed = true;
            console.log(`[bridge] ${intent.id} transfer=${t.id} state=${t.state} applied=${applied.join(",") || "none"}`);
          }
        } catch (err) {
          reconciler.recordError(intent.id, err);
          changed = true;
          console.error(`[bridge] ${intent.id}:`, err instanceof Error ? err.message : err);
        }
      }
      ctx.pollerTicks.bridge++;
      ctx.pollerTicks.lastBridgeAt = new Date().toISOString();
      if (changed) ctx.save();
    } finally {
      bridgeBusy = false;
    }
  }

  async function astraTick(): Promise<void> {
    if (astraBusy) return;
    astraBusy = true;
    let changed = false;
    try {
      for (const intent of engine.intents.values()) {
        if (!ASTRA_OPEN.has(intent.status) || !intent.astraRoutineId) continue;
        const f = reconciler.facts.get(intent.id);
        // Once the bank leg is terminal we stop asking (a chargeback would arrive by webhook).
        if (f?.astraStatus === "processed" && intent.status === "replenished") continue;
        if (f?.astraStatus === "failed" || f?.astraStatus === "cancelled") continue;
        try {
          const r = await readers.astraRoutine(intent.astraRoutineId);
          const transfers = await readers.astraRoutineTransfers(intent.astraRoutineId);
          const before = `${f?.routineStatus}/${f?.astraStatus}`;
          reconciler.recordAstraRoutine(intent.id, r);
          if (transfers[0]) reconciler.recordAstraTransfer(intent.id, transfers[0]);
          const applied = reconciler.reconcile(intent.id);
          const after = reconciler.facts.get(intent.id);
          if (before !== `${after?.routineStatus}/${after?.astraStatus}` || applied.length) {
            changed = true;
            console.log(`[astra] ${intent.id} routine=${r.id} status=${r.status} transfer=${transfers[0]?.id ?? "none"}/${transfers[0]?.status ?? "-"} applied=${applied.join(",") || "none"}`);
          }
        } catch (err) {
          reconciler.recordError(intent.id, err);
          changed = true;
          console.error(`[astra] ${intent.id}:`, err instanceof Error ? err.message : err);
        }
      }
      ctx.pollerTicks.astra++;
      ctx.pollerTicks.lastAstraAt = new Date().toISOString();
      if (changed) ctx.save();
    } finally {
      astraBusy = false;
    }
  }

  const b = setInterval(() => void bridgeTick(), opts.bridgeMs);
  const a = setInterval(() => void astraTick(), opts.astraMs);
  void bridgeTick();
  void astraTick();
  return () => {
    clearInterval(b);
    clearInterval(a);
  };
}
