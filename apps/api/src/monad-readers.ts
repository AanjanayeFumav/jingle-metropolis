/**
 * MonadReaders: settlement facts come from Monad tx receipts; the bank-debit leg stays on the clockwork mock
 * (the demo does not exercise a live bank rail). Implements RailReaders so pollers/reconciler are untouched.
 */
import type { AstraRoutine, AstraTransfer } from "../../../packages/astra/src/client.js";
import type { BridgeTransfer } from "../../../packages/bridge/src/client.js";
import type { MonadReceiptReader } from "../../../packages/monad/src/readers.js";
import type { PartyKey } from "../../../scripts/_state.js";
import type { MockReaders, RailReaders } from "./readers.js";

export class MonadReaders implements RailReaders {
  constructor(
    private readonly receipts: MonadReceiptReader,
    private readonly bank: MockReaders,
  ) {}

  async bridgeTransfer(txHash: string): Promise<BridgeTransfer> {
    const r = await this.receipts.read(txHash);
    return { id: r.id, state: r.state, amount: r.amount, blockNumber: r.blockNumber, confirmedAt: r.confirmedAt } as BridgeTransfer;
  }

  astraRoutine(routineId: string, _party?: PartyKey): Promise<AstraRoutine> {
    return this.bank.astraRoutine(routineId);
  }

  astraRoutineTransfers(routineId: string, _party?: PartyKey): Promise<AstraTransfer[]> {
    return this.bank.astraRoutineTransfers(routineId);
  }

  astraTransfer(transferId: string, _parties: PartyKey[]): Promise<AstraTransfer> {
    return this.bank.astraTransfer(transferId);
  }
}
