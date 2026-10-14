/**
 * Reconciler — turns rail FACTS into engine transitions, in legal order, idempotently.
 *
 * Why facts, not events: Astra says webhooks may be duplicated or out of order, Bridge is polled, Monad receipts
 * are polled, and `fronting → replenished` is illegal (the merchant must be paid before the player's ACH clearing
 * is booked). So every source (webhook, poller, boot, demo trigger) just RECORDS what it saw, then calls
 * reconcile(), which applies whatever is now legal. Re-running it is always safe.
 *
 * TRANSITIONS (core) is untouched. Settlement failure states while fronting have no legal transition and are
 * only flagged (`settlementFailed`) — how to account for a failed settlement is a product decision.
 */
import { type PaymentIntent, canTransition } from "../../../packages/core/src/index.js";
import type { PaymentEngine } from "../../../packages/orchestrator/src/engine.js";
import type { AstraRoutine, AstraTransfer } from "../../../packages/astra/src/client.js";
import type { BridgeTransfer } from "../../../packages/bridge/src/client.js";

export interface RailFacts {
  // settlement leg (Bridge transfer or Monad tx)
  bridgeState?: string;
  settlementFailed?: boolean;
  bridgeCheckedAt?: string;
  /** Monad: block timestamp of the settle() receipt. */
  settlementConfirmedAt?: string;
  settlementBlock?: string;
  // dispute leg (Monad absorbDispute tx, or an Astra chargeback object)
  disputeRef?: string;
  disputeConfirmedAt?: string;
  // bank-debit leg (Astra or mock)
  routineStatus?: string;
  astraTransferId?: string;
  astraStatus?: string;
  astraFailureReason?: string | null;
  chargeback?: Record<string, unknown> | null;
  astraCheckedAt?: string;
  // ops
  startedAt?: string;
  lastError?: string;
}

export type FactsStore = Map<string, RailFacts>;

const BRIDGE_FAILURE = new Set(["returned", "undeliverable", "error", "canceled", "refunded", "refund_in_flight", "refund_failed"]);
const ACH_FAILED = new Set(["failed", "cancelled"]);
/** Dispute statuses that do NOT cost us anything. Everything else counts as a live chargeback. */
const CHARGEBACK_HARMLESS = new Set(["won", "not disputed", "not_disputed", "notdisputed"]);

export function isChargebackActive(cb: Record<string, unknown> | null | undefined): boolean {
  if (!cb) return false;
  const status = String(cb.status ?? "").trim().toLowerCase();
  return status !== "" && !CHARGEBACK_HARMLESS.has(status);
}

export class Reconciler {
  constructor(
    private readonly engine: PaymentEngine,
    readonly facts: FactsStore = new Map(),
  ) {}

  factsFor(intentId: string): RailFacts {
    let f = this.facts.get(intentId);
    if (!f) {
      f = {};
      this.facts.set(intentId, f);
    }
    return f;
  }

  recordBridgeTransfer(intentId: string, t: BridgeTransfer & { confirmedAt?: string; blockNumber?: string }): void {
    const f = this.factsFor(intentId);
    f.bridgeState = String(t.state);
    f.settlementFailed = BRIDGE_FAILURE.has(String(t.state));
    f.bridgeCheckedAt = new Date().toISOString();
    if (t.confirmedAt) f.settlementConfirmedAt = t.confirmedAt;
    if (t.blockNumber) f.settlementBlock = t.blockNumber;
  }

  recordAstraTransfer(intentId: string, t: AstraTransfer): void {
    const f = this.factsFor(intentId);
    f.astraTransferId = t.id;
    f.astraStatus = t.status ? String(t.status) : f.astraStatus;
    f.astraFailureReason = t.failure_reason ?? f.astraFailureReason ?? null;
    if (t.chargeback !== undefined) f.chargeback = t.chargeback;
    f.astraCheckedAt = new Date().toISOString();
  }

  recordAstraRoutine(intentId: string, r: AstraRoutine): void {
    const f = this.factsFor(intentId);
    f.routineStatus = String(r.status);
    f.astraCheckedAt = new Date().toISOString();
  }

  /** A dispute landed (Reg E, or a demo trigger). `ref` is the on-chain absorbDispute tx when the rail has one. */
  recordDispute(intentId: string, p: { status: string; ref?: string; confirmedAt?: string }): void {
    const f = this.factsFor(intentId);
    f.chargeback = { status: p.status, ref: p.ref ?? null };
    if (p.ref) f.disputeRef = p.ref;
    if (p.confirmedAt) f.disputeConfirmedAt = p.confirmedAt;
  }

  recordError(intentId: string, err: unknown): void {
    this.factsFor(intentId).lastError = err instanceof Error ? err.message : String(err);
  }

  /** Apply every fact that is legal right now. Returns the statuses reached, in order. Never throws on no-op. */
  reconcile(intentId: string): PaymentIntent["status"][] {
    const intent = this.engine.intents.get(intentId);
    if (!intent) return [];
    const f = this.facts.get(intentId);
    if (!f) return [];
    const applied: PaymentIntent["status"][] = [];

    // 1. Merchant paid (settlement processed) — must come before any ACH-cleared booking.
    if (f.bridgeState === "payment_processed" && intent.status === "fronting" && canTransition(intent.status, "settled")) {
      this.engine.onSettlementConfirmed(intentId);
      applied.push(intent.status);
    }

    // 2. Player's ACH failed / cancelled (or the routine did) — clean unwind or treasury loss depending on status.
    const achFailed = ACH_FAILED.has(String(f.astraStatus)) || ACH_FAILED.has(String(f.routineStatus));
    if (achFailed && (intent.status === "ach_initiated" || intent.status === "fronting" || intent.status === "holding" || intent.status === "settled")) {
      this.engine.onAchReturned(intentId, f.astraFailureReason ?? f.routineStatus ?? "unknown");
      applied.push(intent.status);
    }

    // 3. Player's ACH cleared — only bookable once the merchant has been paid (settled). Otherwise it waits.
    if (f.astraStatus === "processed" && intent.status === "settled" && canTransition(intent.status, "replenished")) {
      this.engine.onAchCleared(intentId);
      applied.push(intent.status);
    }

    // 4. Reg E dispute — the guarantee. Booked when a dispute is open/lost (decision to revisit: book at open vs lost).
    if (isChargebackActive(f.chargeback) && (intent.status === "settled" || intent.status === "replenished") && canTransition(intent.status, "charged_back")) {
      this.engine.onChargeback(intentId);
      applied.push(intent.status);
    }

    return applied;
  }

  reconcileAll(): void {
    for (const id of this.engine.intents.keys()) this.reconcile(id);
  }
}
