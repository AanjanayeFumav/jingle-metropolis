/**
 * @fumav/core — the Fumav payment domain, in code form.
 *
 * This file IS the product. If a state or transition here is wrong,
 * the product is wrong. Read the TRANSITIONS table as the flow diagram.
 */

/** All money is integer cents. Never floats. */
export type Cents = number;

export type SettlementWindow = "T1" | "T4";

/**
 * The life of a payment.
 *
 * T-1 happy path:  created → ach_initiated → fronting → settled → replenished
 * T-4 happy path:  created → ach_initiated → holding → settled
 *
 * The two states where Fumav eats money (this is the business model's truth):
 *  - loss_absorbed:  ACH returned AFTER we already paid the merchant (T-1 fronting risk — the "4 bps")
 *  - charged_back:   Reg E dispute within 60 days of settlement — the chargeback guarantee in action
 */
export type PaymentIntentStatus =
  | "created" // checkout started; player + merchant + amount known
  | "ach_initiated" // Astra debit routine submitted against player's bank
  | "fronting" // T1: treasury → merchant transfer in flight (Bridge), ACH still pending
  | "holding" // T4: waiting for ACH to clear; merchant not yet paid; no treasury exposure
  | "settled" // merchant has USD in their bank
  | "replenished" // T1 only: player's ACH cleared, treasury made whole
  | "returned" // ACH failed BEFORE merchant was paid — clean unwind, no loss
  | "loss_absorbed" // ACH returned AFTER settlement — Fumav absorbs (treasury loss event)
  | "charged_back"; // post-settlement Reg E dispute — Fumav absorbs (guarantee)

export const TRANSITIONS: Record<PaymentIntentStatus, readonly PaymentIntentStatus[]> = {
  created: ["ach_initiated"],
  ach_initiated: ["fronting", "holding", "returned"],
  fronting: ["settled", "returned"], // return while fronting is in flight: cancel Bridge leg if possible
  holding: ["settled", "returned"],
  settled: ["replenished", "loss_absorbed", "charged_back"],
  replenished: ["charged_back"], // Reg E window outlives replenishment
  returned: [],
  loss_absorbed: [],
  charged_back: [],
} as const;

export function canTransition(from: PaymentIntentStatus, to: PaymentIntentStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

export function assertTransition(from: PaymentIntentStatus, to: PaymentIntentStatus): void {
  if (!canTransition(from, to)) {
    throw new Error(`Illegal payment transition: ${from} → ${to}`);
  }
}

export interface PaymentIntent {
  id: string; // Fumav's ID — becomes Astra client_correlation_id (≤80 chars) and Bridge Idempotency scope
  merchantId: string;
  playerId: string;
  amount: Cents;
  feeAmount: Cents; // Fumav's take (3% or $0.35 floor — see PRICING in orchestrator; config, not hardcode)
  window: SettlementWindow | null; // null until Astra's risk decision is known
  status: PaymentIntentStatus;
  astraRoutineId?: string;
  astraTransferId?: string;
  bridgeTransferId?: string;
  createdAt: string; // ISO
  updatedAt: string;
}

/**
 * Ledger entries — double-entry-lite. Every state transition that moves money
 * emits one of these. The merchant-facing "settlement ledger" view and the
 * float model both read from this stream.
 */
export type LedgerEntryType =
  | "TREASURY_FRONT" // treasury wallet → merchant payout initiated (T1)
  | "MERCHANT_PAYOUT" // merchant received USD (T1 via Bridge, T4 direct)
  | "ACH_REPLENISH" // player ACH cleared into treasury (T1 leg 2)
  | "ACH_RETURN" // player ACH failed/returned
  | "LOSS_WRITEOFF" // treasury eats a post-settlement return (the 4 bps)
  | "CHARGEBACK_ABSORBED" // guarantee invoked — Fumav pays, merchant untouched
  | "FEE_ACCRUED"; // Fumav revenue recognized

export interface LedgerEntry {
  id: string;
  paymentIntentId: string;
  type: LedgerEntryType;
  amount: Cents;
  occurredAt: string; // ISO
  memo?: string;
}
