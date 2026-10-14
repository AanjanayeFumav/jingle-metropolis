/**
 * MonadSettlementRail - the SettlementRail seam implemented on Monad.
 *   settleToMerchant -> JingleSettlement.settle(paymentId, merchant, net, fee)   (one tx: merchant paid, fee into reserve)
 *   absorbDispute    -> JingleSettlement.absorbDispute(paymentId, amount)        (one tx: reserve refills the treasury)
 * The tx hash is the rail's external id; MonadReaders turns the receipt into a settlement state for the reconciler.
 */
import { keccak256, toHex, type Abi, type Address, type Hex, type PublicClient, type WalletClient } from "viem";
import type { Cents } from "../../core/src/index.js";
import type { SettlementRail } from "../../core/src/rails.js";
import { centsToUnits } from "./clients.js";

/** Off-chain PaymentIntent id -> on-chain bytes32 key. Same id in the ledger and in the event. */
export function paymentKey(paymentIntentId: string): Hex {
  return keccak256(toHex(paymentIntentId));
}

export interface MonadRailConfig {
  publicClient: PublicClient;
  walletClient: WalletClient;
  settlementAddress: Address;
  settlementAbi: Abi;
  resolveMerchant(merchantId: string): Promise<Address>;
}

export class MonadSettlementRail implements SettlementRail {
  readonly name = "monad";

  constructor(private readonly cfg: MonadRailConfig) {}

  async settleToMerchant(p: { paymentIntentId: string; merchantId: string; amount: Cents; fee?: Cents }): Promise<{ externalId: string }> {
    const merchant = await this.cfg.resolveMerchant(p.merchantId);
    const hash = await this.write("settle", [paymentKey(p.paymentIntentId), merchant, centsToUnits(p.amount), centsToUnits(p.fee ?? 0)]);
    return { externalId: hash };
  }

  async absorbDispute(p: { paymentIntentId: string; merchantId: string; amount: Cents }): Promise<{ externalId: string }> {
    const hash = await this.write("absorbDispute", [paymentKey(p.paymentIntentId), centsToUnits(p.amount)]);
    return { externalId: hash };
  }

  /** simulate first so a revert surfaces as a readable error before any gas is spent. */
  private async write(functionName: string, args: unknown[]): Promise<Hex> {
    const account = this.cfg.walletClient.account;
    if (!account) throw new Error("wallet client has no account");
    const { request } = await this.cfg.publicClient.simulateContract({
      address: this.cfg.settlementAddress,
      abi: this.cfg.settlementAbi,
      functionName,
      args,
      account,
    });
    return this.cfg.walletClient.writeContract(request);
  }
}
