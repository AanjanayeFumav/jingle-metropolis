/**
 * Merchant-facing DTOs. Everything the merchant view sees passes through here, so rail internals and the
 * settlement asset never leak (tests/view-copy.test.ts enforces the banned-word list on this file too).
 * The operator console (/ops) reads /api/ops instead and is allowed to say everything.
 */
import type { PaymentIntent, PaymentIntentStatus } from "../../../packages/core/src/index.js";
import type { RailFacts } from "./reconcile.js";

export const STATUS_LABEL: Record<PaymentIntentStatus, string> = {
  created: "Started",
  ach_initiated: "Bank debit scheduled",
  fronting: "Payout in flight",
  holding: "Awaiting bank clearing",
  settled: "Paid out",
  replenished: "Paid out - bank cleared",
  returned: "Returned - no payout",
  loss_absorbed: "Paid out - covered by Jingle",
  charged_back: "Paid out - dispute covered by Jingle",
};

/** Settlement states in merchant words (Bridge transfer states, and the Monad receipt states mapped onto them). */
const SETTLEMENT_LABEL: Record<string, string> = {
  in_review: "Submitted",
  awaiting_funds: "Submitted",
  funds_received: "Funds reserved",
  payment_submitted: "Sent to your account",
  payment_processed: "Delivered",
  returned: "Returned",
  undeliverable: "Undeliverable",
  canceled: "Canceled",
  error: "Error",
};

const DEBIT_LABEL: Record<string, string> = {
  active: "Scheduled",
  pending_account_authorization: "Awaiting bank authorization",
  requires_user_verification: "Awaiting verification",
  completed: "Cleared",
  failed: "Failed",
  cancelled: "Cancelled",
  pending: "Clearing",
  processed: "Cleared",
};

export function maskId(id: string | undefined): string {
  if (!id) return "";
  return id.length <= 10 ? id : `${id.slice(0, 4)}…${id.slice(-4)}`;
}

export interface PaymentView {
  id: string;
  merchantId: string;
  player: string;
  amount: number;
  fee: number;
  net: number;
  window: string | null;
  status: PaymentIntentStatus;
  statusLabel: string;
  bankDebit: {
    routineId?: string;
    routineStatus?: string;
    routineLabel: string;
    transferId?: string;
    transferStatus?: string;
    failureReason?: string | null;
    checkedAt?: string;
  };
  settlement: {
    transferId?: string;
    state?: string;
    label: string;
    failed: boolean;
    checkedAt?: string;
    confirmedAt?: string;
    /** Public settlement record (explorer link in MONAD mode). */
    recordUrl?: string;
  };
  dispute?: {
    ref?: string;
    confirmedAt?: string;
    recordUrl?: string;
  };
  error?: string;
  createdAt: string;
  updatedAt: string;
}

export interface ViewLinks {
  recordUrl?(ref: string): string;
}

export function toView(intent: PaymentIntent, facts: RailFacts | undefined, links: ViewLinks = {}): PaymentView {
  const f = facts ?? {};
  const debitKey = f.astraStatus ?? f.routineStatus;
  return {
    id: intent.id,
    merchantId: intent.merchantId,
    player: maskId(intent.playerId),
    amount: intent.amount,
    fee: intent.feeAmount,
    net: intent.amount - intent.feeAmount,
    window: intent.window,
    status: intent.status,
    statusLabel: STATUS_LABEL[intent.status],
    bankDebit: {
      routineId: intent.astraRoutineId,
      routineStatus: f.routineStatus,
      routineLabel: intent.astraRoutineId
        ? (debitKey && DEBIT_LABEL[debitKey]) ?? (f.astraStatus ? "Clearing not yet reported" : "Scheduled - clearing not yet reported")
        : "Not started",
      transferId: f.astraTransferId,
      transferStatus: f.astraStatus,
      failureReason: f.astraFailureReason ?? undefined,
      checkedAt: f.astraCheckedAt,
    },
    settlement: {
      transferId: intent.bridgeTransferId,
      state: f.bridgeState,
      label: intent.bridgeTransferId ? ((f.bridgeState && SETTLEMENT_LABEL[f.bridgeState]) ?? "Submitted") : "Not started",
      failed: Boolean(f.settlementFailed),
      checkedAt: f.bridgeCheckedAt,
      confirmedAt: f.settlementConfirmedAt,
      recordUrl: intent.bridgeTransferId && links.recordUrl ? links.recordUrl(intent.bridgeTransferId) : undefined,
    },
    dispute: f.disputeRef
      ? { ref: f.disputeRef, confirmedAt: f.disputeConfirmedAt, recordUrl: links.recordUrl ? links.recordUrl(f.disputeRef) : undefined }
      : undefined,
    error: f.lastError,
    createdAt: intent.createdAt,
    updatedAt: intent.updatedAt,
  };
}
