/**
 * Tiny Privy Wallets API client (server wallets, no React SDK). Verified against docs.privy.io Oct 13 2026:
 *   POST https://api.privy.io/v1/wallets   Basic base64(appId:appSecret) + privy-app-id, body { chain_type }
 *   -> { id, address, chain_type, created_at (ms), policy_ids, owner_id, ... }
 *   optional privy-idempotency-key: same key within 24h replays the first response (no second wallet).
 *   POST /v1/wallets/{id}/rpc  { method: "eth_signTransaction", params: { transaction } } -> { data: { signed_transaction } }
 *   POST /v1/policies          { version: "1.0", name, chain_type, rules: [{ name, method, conditions, action }] } -> { id, ... }
 * MockPrivyClient derives a deterministic id + address from the key so tests and MOCK=true stay keyless.
 */
import { getAddress, keccak256, toBytes, type Address } from "viem";

export interface PrivyWallet {
  id: string;
  address: Address;
  chainType: string;
}

export interface CreateWalletOptions {
  /** Same key -> same wallet (Privy replays within 24h; the mock is deterministic forever). */
  idempotencyKey: string;
  displayName?: string;
  /** At most one policy per wallet (Privy limit). */
  policyIds?: string[];
}

export interface PrivyClient {
  readonly provider: "privy" | "privy-mock";
  createWallet(opts: CreateWalletOptions): Promise<PrivyWallet>;
}

export const PRIVY_API = "https://api.privy.io";

export class RestPrivyClient implements PrivyClient {
  readonly provider = "privy" as const;
  constructor(private readonly cfg: { appId: string; appSecret: string; baseUrl?: string; fetch?: typeof fetch }) {}

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    return {
      Authorization: "Basic " + Buffer.from(`${this.cfg.appId}:${this.cfg.appSecret}`).toString("base64"),
      "privy-app-id": this.cfg.appId,
      "Content-Type": "application/json",
      ...extra,
    };
  }

  async request<T>(method: "GET" | "POST", path: string, body?: unknown, extra?: Record<string, string>): Promise<T> {
    const res = await (this.cfg.fetch ?? fetch)((this.cfg.baseUrl ?? PRIVY_API) + path, {
      method,
      headers: this.headers(extra),
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`Privy ${method} ${path} -> ${res.status}: ${text.slice(0, 300)}`);
    return JSON.parse(text) as T;
  }

  async createWallet(opts: CreateWalletOptions): Promise<PrivyWallet> {
    const w = await this.request<{ id: string; address: string; chain_type: string }>(
      "POST",
      "/v1/wallets",
      {
        chain_type: "ethereum",
        ...(opts.displayName ? { display_name: opts.displayName.slice(0, 100) } : {}),
        ...(opts.policyIds?.length ? { policy_ids: opts.policyIds } : {}),
      },
      { "privy-idempotency-key": opts.idempotencyKey },
    );
    return { id: w.id, address: getAddress(w.address), chainType: w.chain_type };
  }

  /** Wallet RPC (eth_signTransaction etc.). App-owned wallets (no owner) need no authorization signature. */
  async rpc<T>(walletId: string, body: { method: string; params: unknown }): Promise<T> {
    return this.request<T>("POST", `/v1/wallets/${encodeURIComponent(walletId)}/rpc`, body);
  }

  async createPolicy(policy: PrivyPolicyInput, idempotencyKey?: string): Promise<{ id: string }> {
    return this.request<{ id: string }>("POST", "/v1/policies", { version: "1.0", chain_type: "ethereum", ...policy }, idempotencyKey ? { "privy-idempotency-key": idempotencyKey } : undefined);
  }
}

export interface PrivyPolicyCondition {
  field_source: "ethereum_transaction" | "ethereum_calldata";
  field: string;
  operator: "eq" | "gt" | "gte" | "lt" | "lte" | "in";
  value: string | string[];
  abi?: unknown[];
}

export interface PrivyPolicyInput {
  name: string;
  rules: { name: string; method: string; conditions: PrivyPolicyCondition[]; action: "ALLOW" | "DENY" }[];
}

export class MockPrivyClient implements PrivyClient {
  readonly provider = "privy-mock" as const;
  async createWallet(opts: CreateWalletOptions): Promise<PrivyWallet> {
    const h = keccak256(toBytes(`privy-mock:${opts.idempotencyKey}`));
    return { id: `mock${h.slice(2, 26)}`, address: getAddress(`0x${h.slice(-40)}`), chainType: "ethereum" };
  }
}

/** Real client only when keys are present and the runtime is not the keyless mock. */
export function privyClientFor(env: NodeJS.ProcessEnv, opts: { mock: boolean }): PrivyClient {
  if (opts.mock || !env.PRIVY_APP_ID || !env.PRIVY_APP_SECRET) return new MockPrivyClient();
  return new RestPrivyClient({ appId: env.PRIVY_APP_ID, appSecret: env.PRIVY_APP_SECRET });
}
