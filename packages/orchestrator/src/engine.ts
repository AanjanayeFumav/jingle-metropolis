/**
 * PaymentEngine — drives a PaymentIntent through the state machine,
 * books ledger entries on every money-moving transition.
 * In-memory stores for v0.1; Postgres later. Rails injected (mock, Bridge, Monad).
 */
import {
  type Cents,
  type LedgerEntry,
  type LedgerEntryType,
  type PaymentIntent,
  type PaymentIntentStatus,
  assertTransition,
} from "../../core/src/index.js";
import type { ConsumerRail, RiskEngine, SettlementRail } from "../../core/src/rails.js";

export interface PricingConfig {
  /** e.g. 0.03 for 3% */
  rate: number;
  /** floor in cents, e.g. 35 */
  floorCents: Cents;
}

/** Locked pricing (Sep 2026): 3% or $0.35, whichever is greater. One constant, no tiers. */
export const PRICING: PricingConfig = { rate: 0.03, floorCents: 35 };

export function feeFor(amount: Cents, pricing: PricingConfig): Cents {
  return Math.max(Math.round(amount * pricing.rate), pricing.floorCents);
}

let seq = 0;
const id = (prefix: string) => `${prefix}_${Date.now().toString(36)}${(seq++).toString(36)}`;

export class PaymentEngine {
  readonly intents = new Map<string, PaymentIntent>();
  readonly ledger: LedgerEntry[] = [];

  constructor(
    private readonly consumer: ConsumerRail,
    private readonly settlement: SettlementRail,
    private readonly risk: RiskEngine,
    private readonly pricing: PricingConfig = PRICING,
  ) {}

  /** The settlement rail in use (the API's dispute trigger needs its optional absorbDispute). */
  get settlementRail(): SettlementRail {
    return this.settlement;
  }

  /** Checkout tap. */
  createPayment(p: { merchantId: string; playerId: string; amount: Cents }): PaymentIntent {
    const now = new Date().toISOString();
    const intent: PaymentIntent = {
      id: id("pay"),
      merchantId: p.merchantId,
      playerId: p.playerId,
      amount: p.amount,
      feeAmount: feeFor(p.amount, this.pricing),
      window: null,
      status: "created",
      createdAt: now,
      updatedAt: now,
    };
    this.intents.set(intent.id, intent);
    return intent;
  }

  /** Kick off the flow: ACH pull → risk decision → (T1) front settlement. */
  async start(intentId: string): Promise<PaymentIntent> {
    const intent = this.get(intentId);
    const pull = await this.consumer.initiateAchPull({
      paymentIntentId: intent.id,
      playerId: intent.playerId,
      amount: intent.amount,
    });
    intent.astraRoutineId = pull.externalId;
    this.transition(intent, "ach_initiated");

    const decision = await this.risk.decide({
      paymentIntentId: intent.id,
      playerId: intent.playerId,
      amount: intent.amount,
    });
    intent.window = decision.window;

    if (decision.window === "T1") {
      const net = intent.amount - intent.feeAmount;
      const settle = await this.settlement.settleToMerchant({
        paymentIntentId: intent.id,
        merchantId: intent.merchantId,
        amount: net,
        fee: intent.feeAmount,
      });
      intent.bridgeTransferId = settle.externalId;
      this.transition(intent, "fronting");
      this.book(intent, "TREASURY_FRONT", -net, `front to ${intent.merchantId} (${this.settlement.name})`);
    } else {
      this.transition(intent, "holding");
    }
    return intent;
  }

  /** Settlement rail confirmed: merchant has the value. */
  onSettlementConfirmed(intentId: string): PaymentIntent {
    const intent = this.get(intentId);
    this.transition(intent, "settled");
    const net = intent.amount - intent.feeAmount;
    this.book(intent, "MERCHANT_PAYOUT", net, `merchant credited (net of fee)`);
    this.book(intent, "FEE_ACCRUED", intent.feeAmount, `jingle fee`);
    return intent;
  }

  /** Player's ACH cleared (T+1) — treasury made whole. */
  onAchCleared(intentId: string): PaymentIntent {
    const intent = this.get(intentId);
    this.transition(intent, "replenished");
    this.book(intent, "ACH_REPLENISH", intent.amount, `player ACH landed`);
    return intent;
  }

  /** ACH failed/returned. Loss only if we already settled to the merchant. */
  onAchReturned(intentId: string, code = "R00"): PaymentIntent {
    const intent = this.get(intentId);
    this.book(intent, "ACH_RETURN", 0, `return code ${code}`);
    if (intent.status === "settled") {
      this.transition(intent, "loss_absorbed");
      const net = intent.amount - intent.feeAmount;
      this.book(intent, "LOSS_WRITEOFF", -net, `post-settlement return — treasury absorbs (the 4bps)`);
    } else {
      this.transition(intent, "returned");
    }
    return intent;
  }

  /** Reg E dispute post-settlement — the chargeback guarantee. Merchant untouched. */
  onChargeback(intentId: string): PaymentIntent {
    const intent = this.get(intentId);
    this.transition(intent, "charged_back");
    this.book(intent, "CHARGEBACK_ABSORBED", -intent.amount, `Reg E dispute — Jingle absorbs, merchant keeps funds`);
    return intent;
  }

  /** Treasury P&L across all payments — the float model's seed. */
  summary() {
    const total = (type: LedgerEntryType) =>
      this.ledger.filter((e) => e.type === type).reduce((s, e) => s + e.amount, 0);
    return {
      // `0 - x` (not `-x`) so an empty column is +0, never -0 — dashboards would print "-0".
      fronted: 0 - total("TREASURY_FRONT"),
      replenished: total("ACH_REPLENISH"),
      feesEarned: total("FEE_ACCRUED"),
      lossesAbsorbed: 0 - total("LOSS_WRITEOFF"),
      chargebacksAbsorbed: 0 - total("CHARGEBACK_ABSORBED"),
    };
  }

  private get(intentId: string): PaymentIntent {
    const intent = this.intents.get(intentId);
    if (!intent) throw new Error(`Unknown payment intent: ${intentId}`);
    return intent;
  }

  private transition(intent: PaymentIntent, to: PaymentIntentStatus): void {
    assertTransition(intent.status, to);
    intent.status = to;
    intent.updatedAt = new Date().toISOString();
  }

  private book(intent: PaymentIntent, type: LedgerEntryType, amount: Cents, memo?: string): void {
    this.ledger.push({
      id: id("led"),
      paymentIntentId: intent.id,
      type,
      amount,
      occurredAt: new Date().toISOString(),
      memo,
    });
  }
}
