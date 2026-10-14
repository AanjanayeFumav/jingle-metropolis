/**
 * buildRuntime(): engine + rails + readers for one API process.
 *  MOCK=true   → mock rails + clockwork readers (no keys, no network). Default when nothing is set.
 *  MONAD=true  → mock bank leg + REAL Monad settlement (JingleSettlement contract; needs .env MONAD_PRIVATE_KEY
 *                and deployments/monad-testnet.json from `npm run deploy:monad`). This is the hackathon demo mode.
 *  MOCK=false  → real AstraConsumerRail + BridgeSettlementRail from .env and .fumav-state.json (pre-existing, not exercised here).
 */
import type { Address } from "viem";
import { AstraClient } from "../../../packages/astra/src/client.js";
import { AstraConsumerRail } from "../../../packages/astra/src/rail.js";
import { BridgeClient } from "../../../packages/bridge/src/client.js";
import { BridgeSettlementRail } from "../../../packages/bridge/src/rail.js";
import { explorerAddressUrl, explorerTxUrl } from "../../../packages/monad/src/chain.js";
import { loadArtifact, loadDeployment, publicClientFor, walletClientFor, type Deployment } from "../../../packages/monad/src/clients.js";
import { MonadReceiptReader } from "../../../packages/monad/src/readers.js";
import { MonadSettlementRail } from "../../../packages/monad/src/rail.js";
import { PRICING, PaymentEngine } from "../../../packages/orchestrator/src/engine.js";
import { AlwaysT1Risk, MockConsumerRail, MockSettlementRail } from "../../../packages/orchestrator/src/mock-rails.js";
import { readState } from "../../../scripts/_state.js";
import { TokenStore } from "./astra-tokens.js";
import { MonadReaders } from "./monad-readers.js";
import { LiveReaders, MockReaders, type MockReaderOptions, type RailReaders } from "./readers.js";
import { Reconciler } from "./reconcile.js";

/** Demo studio. Fictional. */
export const DEMO_MERCHANT_ID = "merch_starfall";
export const DEMO_MERCHANT_NAME = "Starfall Studios";

export interface Runtime {
  mode: "mock" | "monad" | "live";
  engine: PaymentEngine;
  reconciler: Reconciler;
  readers: RailReaders;
  tokens?: TokenStore;
  /** playerId used for script-initiated payments (the Astra user id in live mode). */
  defaultPlayerId: string;
  merchantId: string;
  merchantName: string;
  /** MONAD mode only: addresses + explorer links for the operator console. */
  chain?: {
    deployment: Deployment;
    txUrl(hash: string): string;
    addressUrl(address: string): string;
    /** Live balances for /api/ops. */
    balances(): Promise<{ treasuryMon: string; treasuryUsd: number; merchantUsd: number; reserve: number; totalSettled: number; totalDisputed: number }>;
  };
}

function need(env: NodeJS.ProcessEnv, name: string): string {
  const v = env[name];
  if (!v) throw new Error(`missing ${name} in .env`);
  return v;
}

export function buildRuntime(env: NodeJS.ProcessEnv = process.env, mockOpts?: MockReaderOptions): Runtime {
  const monad = env.MONAD === "true";
  const mock = !monad && env.MOCK !== "false";

  if (mock) {
    const engine = new PaymentEngine(new MockConsumerRail(), new MockSettlementRail(), new AlwaysT1Risk(), PRICING);
    return {
      mode: "mock",
      engine,
      reconciler: new Reconciler(engine),
      readers: new MockReaders(mockOpts ?? { bridgeStepMs: 1_500, astraClearMs: 20_000 }),
      defaultPlayerId: "player_demo",
      merchantId: DEMO_MERCHANT_ID,
      merchantName: DEMO_MERCHANT_NAME,
    };
  }

  if (monad) {
    const deployment = loadDeployment();
    const publicClient = publicClientFor(env);
    const walletClient = walletClientFor(env);
    const settlementAbi = loadArtifact("JingleSettlement").abi;
    const usdAbi = loadArtifact("TestUSD").abi;
    if (walletClient.account.address.toLowerCase() !== deployment.treasury.toLowerCase()) {
      throw new Error(`MONAD_PRIVATE_KEY is ${walletClient.account.address} but deployments/monad-testnet.json was deployed by ${deployment.treasury}; redeploy or fix the key`);
    }
    const settlement = new MonadSettlementRail({
      publicClient,
      walletClient,
      settlementAddress: deployment.settlement,
      settlementAbi,
      async resolveMerchant(merchantId) {
        if (merchantId !== DEMO_MERCHANT_ID) throw new Error(`unknown merchant ${merchantId}; only ${DEMO_MERCHANT_ID} is onboarded`);
        return deployment.merchant;
      },
    });
    const engine = new PaymentEngine(new MockConsumerRail(), settlement, new AlwaysT1Risk(), PRICING);
    const balOf = (who: Address) => publicClient.readContract({ address: deployment.testUsd, abi: usdAbi, functionName: "balanceOf", args: [who] }) as Promise<bigint>;
    const readNum = (fn: string) => publicClient.readContract({ address: deployment.settlement, abi: settlementAbi, functionName: fn }) as Promise<bigint>;
    const cents = (units: bigint) => Number(units / 10_000n);
    return {
      mode: "monad",
      engine,
      reconciler: new Reconciler(engine),
      readers: new MonadReaders(new MonadReceiptReader(publicClient), new MockReaders(mockOpts ?? { bridgeStepMs: 1_000, astraClearMs: 20_000 })),
      defaultPlayerId: "player_demo",
      merchantId: DEMO_MERCHANT_ID,
      merchantName: DEMO_MERCHANT_NAME,
      chain: {
        deployment,
        txUrl: (hash) => explorerTxUrl(env, hash),
        addressUrl: (address) => explorerAddressUrl(env, address),
        async balances() {
          const [mon, tre, mer, reserve, settled, disputed] = await Promise.all([
            publicClient.getBalance({ address: deployment.treasury }),
            balOf(deployment.treasury),
            balOf(deployment.merchant),
            readNum("reserve"),
            readNum("totalSettled"),
            readNum("totalDisputed"),
          ]);
          return { treasuryMon: (Number(mon) / 1e18).toFixed(4), treasuryUsd: cents(tre), merchantUsd: cents(mer), reserve: cents(reserve), totalSettled: cents(settled), totalDisputed: cents(disputed) };
        },
      },
    };
  }

  // ---- live Astra + Bridge (pre-existing; kept intact, not part of the hackathon demo) ----
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
    merchantName: DEMO_MERCHANT_NAME,
  };
}
