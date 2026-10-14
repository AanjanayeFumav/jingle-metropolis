/**
 * MonadReaders - the READ side for MONAD mode: a tx receipt becomes a settlement state the reconciler already
 * understands (`payment_processed` = merchant has the funds). The bank-debit leg stays on the mock clockwork
 * readers (the demo does not exercise a live bank rail).
 */
import type { Hex, PublicClient } from "viem";

export interface SettlementReceipt {
  id: string;
  state: "in_review" | "payment_processed" | "error";
  amount: string;
  blockNumber?: string;
  confirmedAt?: string;
}

export class MonadReceiptReader {
  private readonly cache = new Map<string, SettlementReceipt>();

  constructor(private readonly publicClient: PublicClient) {}

  async read(txHash: string): Promise<SettlementReceipt> {
    const hit = this.cache.get(txHash);
    if (hit && hit.state !== "in_review") return hit;
    let receipt;
    try {
      receipt = await this.publicClient.getTransactionReceipt({ hash: txHash as Hex });
    } catch {
      return { id: txHash, state: "in_review", amount: "0.00" };
    }
    const block = await this.publicClient.getBlock({ blockNumber: receipt.blockNumber });
    const out: SettlementReceipt = {
      id: txHash,
      state: receipt.status === "success" ? "payment_processed" : "error",
      amount: "0.00",
      blockNumber: receipt.blockNumber.toString(),
      confirmedAt: new Date(Number(block.timestamp) * 1000).toISOString(),
    };
    this.cache.set(txHash, out);
    return out;
  }
}
