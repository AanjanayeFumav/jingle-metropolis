/**
 * AstraConsumerRail — the real ConsumerRail (see core/rails.ts) over the Astra client.
 *
 * Proven live in Session 1 (Sep 12 2026): routine 68c3143b-c7e7-4efa-9c0d-88038cec5428,
 * $19.99 one-time ach T+1, client_correlation_id = a Fumav PaymentIntent id.
 *
 * v0.1 wiring: ONE destination (Fumav's Astra business account) and a resolver that maps a Fumav
 * playerId → that player's Astra bearer token + balance-capable source account (Plaid-linked; routing-number
 * accounts are rejected by Astra as a source). Session 3 supplies the resolver from its player store;
 * the Session 1 scripts can supply it from .fumav-state.json.
 */
import type { ConsumerRail } from "../../core/src/rails.js";
import { AstraClient, usdFromCents } from "./client.js";

export interface AstraPlayerCreds {
  /** Valid (refreshed) access token for the player. */
  accessToken: string;
  /** Balance-capable Astra account id to debit. */
  sourceAccountId: string;
}

export interface AstraRailConfig {
  client: AstraClient;
  /** Fumav's business user + linked account on Astra — where every pull lands. */
  destination: { accountId: string; userId: string };
  resolvePlayer(playerId: string): Promise<AstraPlayerCreds>;
  /** Default T+1 (locked: T-1 only for now). */
  settlementSpeed?: "T+1" | "T+2" | "T+4";
}

export class AstraConsumerRail implements ConsumerRail {
  readonly name = "astra";

  constructor(private readonly cfg: AstraRailConfig) {}

  async initiateAchPull(p: { paymentIntentId: string; playerId: string; amount: number }): Promise<{ externalId: string }> {
    if (p.paymentIntentId.length > 80) {
      throw new Error(`paymentIntentId exceeds Astra's 80-char client_correlation_id limit: ${p.paymentIntentId}`);
    }
    const creds = await this.cfg.resolvePlayer(p.playerId);
    const routine = await this.cfg.client.createRoutine(creds.accessToken, {
      type: "one-time",
      name: `Fumav ${p.paymentIntentId}`,
      source_id: creds.sourceAccountId,
      destination_id: this.cfg.destination.accountId,
      destination_user_id: this.cfg.destination.userId,
      amount: usdFromCents(p.amount),
      payment_type: "ach",
      preferred_settlement_speed: this.cfg.settlementSpeed ?? "T+1",
      client_correlation_id: p.paymentIntentId,
    });
    return { externalId: routine.id };
  }
}
