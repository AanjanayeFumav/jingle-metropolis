/**
 * Rail interfaces — the seams that keep vendors swappable.
 * Astra implements ConsumerRail. Bridge and Monad implement SettlementRail
 * (Brale / Coinbase CDP are drop-in candidates behind the same seam).
 */
import type { Cents, SettlementWindow } from "./index.js";

export interface RiskDecision {
  window: SettlementWindow;
  reason: string;
}

/** v0.1: everything routes T-1. Astra's real decision field replaces this later. */
export interface RiskEngine {
  decide(p: { paymentIntentId: string; playerId: string; amount: Cents }): Promise<RiskDecision>;
}

/** Consumer leg: pull money from the player's linked bank (Astra). */
export interface ConsumerRail {
  readonly name: string;
  initiateAchPull(p: {
    paymentIntentId: string; // becomes client_correlation_id
    playerId: string;
    amount: Cents;
  }): Promise<{ externalId: string }>;
}

/** Settlement leg: move value from the Jingle treasury to the merchant (Bridge, Monad). */
export interface SettlementRail {
  readonly name: string;
  settleToMerchant(p: {
    paymentIntentId: string;
    merchantId: string;
    amount: Cents; // amount net of Jingle fee
    fee?: Cents; // Jingle's take; on-chain rails split it into the dispute reserve in the same transaction
  }): Promise<{ externalId: string }>;
  /** Optional: a post-settlement dispute or return. The rail makes the treasury whole; the merchant is untouched. */
  absorbDispute?(p: { paymentIntentId: string; merchantId: string; amount: Cents }): Promise<{ externalId: string }>;
}
