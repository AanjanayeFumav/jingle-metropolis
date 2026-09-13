/** Mock rails — the engine runs with zero keys, zero network. MOCK=true forever-path. */
import type { Cents } from "../../core/src/index.js";
import type { ConsumerRail, RiskDecision, RiskEngine, SettlementRail } from "../../core/src/rails.js";

let n = 0;

export class MockConsumerRail implements ConsumerRail {
  readonly name = "mock-astra";
  async initiateAchPull(): Promise<{ externalId: string }> {
    return { externalId: `mock_routine_${++n}` };
  }
}

export class MockSettlementRail implements SettlementRail {
  readonly name = "mock-bridge";
  async settleToMerchant(): Promise<{ externalId: string }> {
    return { externalId: `mock_transfer_${++n}` };
  }
}

/** v0.1 policy: everything is T-1. */
export class AlwaysT1Risk implements RiskEngine {
  async decide(p: { amount: Cents }): Promise<RiskDecision> {
    return { window: "T1", reason: `stub: route-all-T1 (amount ${p.amount}¢)` };
  }
}
