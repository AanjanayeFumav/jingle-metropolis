/**
 * RailReaders: the READ side of both rails, behind one interface so MOCK=true can advance a payment
 * through every state with no keys and no network (the mock rails only return ids; something has to
 * report that the transfer processed).
 */
import type { AstraClient, AstraRoutine, AstraTransfer } from "../../../packages/astra/src/client.js";
import type { BridgeClient, BridgeTransfer } from "../../../packages/bridge/src/client.js";
import type { PartyKey } from "../../../scripts/_state.js";
import type { TokenStore } from "./astra-tokens.js";

export interface RailReaders {
  bridgeTransfer(transferId: string): Promise<BridgeTransfer>;
  astraRoutine(routineId: string, party?: PartyKey): Promise<AstraRoutine>;
  astraRoutineTransfers(routineId: string, party?: PartyKey): Promise<AstraTransfer[]>;
  /** Tries each party's session in order (a webhook's user_id may be the player or the business). */
  astraTransfer(transferId: string, parties: PartyKey[]): Promise<AstraTransfer>;
}

export class LiveReaders implements RailReaders {
  constructor(
    private readonly astra: AstraClient,
    private readonly bridge: BridgeClient,
    private readonly tokens: TokenStore,
  ) {}

  bridgeTransfer(transferId: string): Promise<BridgeTransfer> {
    return this.bridge.getTransfer(transferId);
  }

  async astraRoutine(routineId: string, party: PartyKey = "player"): Promise<AstraRoutine> {
    return this.astra.getRoutine(await this.tokens.token(party), routineId);
  }

  async astraRoutineTransfers(routineId: string, party: PartyKey = "player"): Promise<AstraTransfer[]> {
    return this.astra.listRoutineTransfers(await this.tokens.token(party), routineId);
  }

  async astraTransfer(transferId: string, parties: PartyKey[]): Promise<AstraTransfer> {
    let lastErr: unknown;
    for (const party of parties) {
      try {
        return await this.astra.getTransfer(await this.tokens.token(party), transferId);
      } catch (err) {
        lastErr = err;
      }
    }
    throw lastErr ?? new Error(`astraTransfer ${transferId}: no party could read it`);
  }
}

export interface MockReaderOptions {
  /** Time between Bridge states: in_review → funds_received → payment_submitted → payment_processed. */
  bridgeStepMs: number;
  /** Time until the Astra transfer appears (half) and clears (full). */
  astraClearMs: number;
}

const BRIDGE_PATH = ["in_review", "funds_received", "payment_submitted", "payment_processed"] as const;

/** Deterministic clockwork: state is a function of time since the id was first asked about. */
export class MockReaders implements RailReaders {
  private readonly firstSeen = new Map<string, number>();

  constructor(private readonly opts: MockReaderOptions = { bridgeStepMs: 5_000, astraClearMs: 30_000 }) {}

  private elapsed(id: string): number {
    const t0 = this.firstSeen.get(id) ?? Date.now();
    if (!this.firstSeen.has(id)) this.firstSeen.set(id, t0);
    return Date.now() - t0;
  }

  async bridgeTransfer(transferId: string): Promise<BridgeTransfer> {
    const idx = Math.min(BRIDGE_PATH.length - 1, Math.floor(this.elapsed(transferId) / this.opts.bridgeStepMs));
    return { id: transferId, state: BRIDGE_PATH[idx], amount: "0.00" };
  }

  async astraRoutine(routineId: string): Promise<AstraRoutine> {
    const done = this.elapsed(routineId) >= this.opts.astraClearMs;
    return { id: routineId, status: done ? "completed" : "active", type: "one-time", payment_type: "ach" };
  }

  async astraRoutineTransfers(routineId: string): Promise<AstraTransfer[]> {
    const e = this.elapsed(routineId);
    if (e < this.opts.astraClearMs / 2) return [];
    return [{ id: `mock_ach_${routineId}`, routine_id: routineId, status: e >= this.opts.astraClearMs ? "processed" : "pending" }];
  }

  async astraTransfer(transferId: string): Promise<AstraTransfer> {
    const routineId = transferId.startsWith("mock_ach_") ? transferId.slice("mock_ach_".length) : undefined;
    const done = routineId ? this.elapsed(routineId) >= this.opts.astraClearMs : true;
    return { id: transferId, routine_id: routineId, status: done ? "processed" : "pending" };
  }
}
