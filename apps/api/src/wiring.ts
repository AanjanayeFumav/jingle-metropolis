/**
 * buildRuntime(): engine + rails + readers for one API process.
 *  MOCK=true  → mock rails + clockwork readers (no keys, no network). Default when MOCK is unset.
 *  MOCK=false → real AstraConsumerRail + BridgeSettlementRail from .env and .fumav-state.json.
 */
import { AstraClient } from "../../../packages/astra/src/client.js";
import { AstraConsumerRail } from "../../../packages/astra/src/rail.js";
import { BridgeClient } from "../../../packages/bridge/src/client.js";
import { BridgeSettlementRail } from "../../../packages/bridge/src/rail.js";
import { PRICING, PaymentEngine } from "../../../packages/orchestrator/src/engine.js";
import { AlwaysT1Risk, MockConsumerRail, MockSettlementRail } from "../../../packages/orchestrator/src/mock-rails.js";
import { readState } from "../../../scripts/_state.js";
import { TokenStore } from "./astra-tokens.js";
import { LiveReaders, MockReaders, type MockReaderOptions, type RailReaders } from "./readers.js";
import { Reconciler } from "./reconcile.js";

export const DEMO_MERCHANT_ID = "merch_sarena";

export interface Runtime {
  mode: "mock" | "live";
  engine: PaymentEngine;
  reconciler: Reconciler;
  readers: RailReaders;
  tokens?: TokenStore;
  /** Fumav playerId used for script-initiated payments (the Astra user id in live mode). */
  defaultPlayerId: string;
  merchantId: string;
}

function need(env: NodeJS.ProcessEnv, name: string): string {
  const v = env[name];
  if (!v) throw new Error(`missing ${name} in .env`);
  return v;
}

export function buildRuntime(env: NodeJS.ProcessEnv = process.env, mockOpts?: MockReaderOptions): Runtime {
  const mock = env.MOCK !== "false";
  if (mock) {
    const engine = new PaymentEngine(new MockConsumerRail(), new MockSettlementRail(), new AlwaysT1Risk(), PRICING);
    return {
      mode: "mock",
      engine,
      reconciler: new Reconciler(engine),
      readers: new MockReaders(mockOpts),
      defaultPlayerId: "player_demo",
      merchantId: DEMO_MERCHANT_ID,
    };
  }

  const s = readState();
  const missing = [
    !s.player?.tokens && "player.tokens (oauth:astra -- --party player)",
    !s.player?.user_id && "player.user_id",
    !s.player?.account_id && "player.account_id (plaid:astra)",
    !s.business?.tokens && "business.tokens (oauth:astra -- --party business)",
    !s.business?.user_id && "business.user_id",
    !s.business?.account_id && "business.account_id (link:astra -- --party business)",
    !s.bridge?.treasury_wallet_id && "bridge.treasury_wallet_id (setup:bridge)",
    !s.bridge?.merchant_customer_id && "bridge.merchant_customer_id (customers:bridge)",
    !s.bridge?.merchant_external_account_id && "bridge.merchant_external_account_id (setup:bridge)",
  ].filter(Boolean);
  if (missing.length) throw new Error(`live mode needs .fumav-state.json entries:\n  - ${missing.join("\n  - ")}`);

  const astra = new AstraClient({
    clientId: need(env, "ASTRA_CLIENT_ID"),
    clientSecret: need(env, "ASTRA_CLIENT_SECRET"),
    sandbox: (env.ASTRA_SANDBOX ?? "true") !== "false",
    oauthHost: env.ASTRA_OAUTH_HOST || undefined,
  });
  const bridge = new BridgeClient({
    apiKey: need(env, "BRIDGE_API_KEY"),
    sandbox: (env.BRIDGE_SANDBOX ?? "true") !== "false",
  });
  const tokens = new TokenStore(astra, need(env, "ASTRA_REDIRECT_URI"));

  const consumer = new AstraConsumerRail({
    client: astra,
    destination: { accountId: s.business!.account_id!, userId: s.business!.user_id! },
    async resolvePlayer(playerId) {
      const st = readState();
      if (playerId !== st.player?.user_id) throw new Error(`unknown player ${playerId}; only the sandbox player is linked`);
      return { accessToken: await tokens.token("player"), sourceAccountId: st.player!.account_id! };
    },
  });
  const settlement = new BridgeSettlementRail({
    client: bridge,
    treasuryWalletId: s.bridge!.treasury_wallet_id!,
    treasuryCurrency: "usdc",
    async resolveMerchant(merchantId) {
      const st = readState();
      if (merchantId !== DEMO_MERCHANT_ID) throw new Error(`unknown merchant ${merchantId}; only ${DEMO_MERCHANT_ID} is onboarded`);
      return { customerId: st.bridge!.merchant_customer_id!, externalAccountId: st.bridge!.merchant_external_account_id! };
    },
  });

  const engine = new PaymentEngine(consumer, settlement, new AlwaysT1Risk(), PRICING);
  return {
    mode: "live",
    engine,
    reconciler: new Reconciler(engine),
    readers: new LiveReaders(astra, bridge, tokens),
    tokens,
    defaultPlayerId: s.player!.user_id!,
    merchantId: DEMO_MERCHANT_ID,
  };
}
