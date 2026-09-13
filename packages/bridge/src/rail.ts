/**
 * BridgeSettlementRail — the real SettlementRail (see core/rails.ts) over the Bridge client.
 *
 * T-1 fronting leg: Fumav's prefunded treasury wallet (USDC) → merchant's bank via ACH, `on_behalf_of` the
 * merchant. Crypto never surfaces: callers pass cents and a merchantId, get back a Bridge transfer id.
 *
 * Swappable by design: Brale / Coinbase implement the same SettlementRail seam.
 */
import type { SettlementRail } from "../../core/src/rails.js";
import { type BridgeClient, type BridgeCurrency, idempotencyKeyFor, usdStringFromCents } from "./client.js";

export interface BridgeMerchantRoute {
  /** Bridge customer id of the merchant (goes in on_behalf_of). */
  customerId: string;
  /** Merchant's bank on Bridge. */
  externalAccountId: string;
}

export interface BridgeRailConfig {
  client: BridgeClient;
  /** Fumav's treasury Bridge wallet (prefunded). */
  treasuryWalletId: string;
  /** Stablecoin the treasury holds. */
  treasuryCurrency?: Extract<BridgeCurrency, "usdc" | "usdb">;
  resolveMerchant(merchantId: string): Promise<BridgeMerchantRoute>;
}

export class BridgeSettlementRail implements SettlementRail {
  readonly name = "bridge";

  constructor(private readonly cfg: BridgeRailConfig) {}

  async settleToMerchant(p: { paymentIntentId: string; merchantId: string; amount: number }): Promise<{ externalId: string }> {
    const merchant = await this.cfg.resolveMerchant(p.merchantId);
    const transfer = await this.cfg.client.createTransfer(
      {
        amount: usdStringFromCents(p.amount),
        on_behalf_of: merchant.customerId,
        client_reference_id: p.paymentIntentId,
        source: {
          payment_rail: "bridge_wallet",
          currency: this.cfg.treasuryCurrency ?? "usdc",
          bridge_wallet_id: this.cfg.treasuryWalletId,
        },
        destination: {
          payment_rail: "ach",
          currency: "usd",
          external_account_id: merchant.externalAccountId,
        },
      },
      // Same intent → same key → Bridge returns the original transfer instead of paying twice.
      idempotencyKeyFor(`settle:${p.paymentIntentId}`),
    );
    return { externalId: transfer.id };
  }
}
