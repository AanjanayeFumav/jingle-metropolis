/**
 * @fumav/bridge — thin, typed client for Bridge's sandbox/production API.
 * Settlement leg: treasury Bridge wallet (USDC) → merchant bank via ACH offramp, `on_behalf_of` the merchant.
 *
 * Verified against apidocs.bridge.xyz (Sep 2026):
 *  - Base: https://api.sandbox.bridge.xyz/v0 (sk-test keys) | https://api.bridge.xyz/v0
 *  - Auth: `Api-Key` header on every request.
 *  - `Idempotency-Key` REQUIRED on every POST. Unique per request; Bridge remembers it 24h; same key +
 *    different body → idempotency error. We derive it from PaymentIntent.id for money-moving calls so a retry
 *    can never double-pay (see idempotencyKeyFor).
 *  - Sandbox: no real money, no payment webhooks, no Plaid, fake wallet addresses. simulate_kyc_approval and
 *    simulate_deposit are sandbox-only.
 *
 * Amounts on Bridge are decimal STRINGS ("19.39"). Convert from Fumav's integer cents ONLY via
 * usdStringFromCents() at this boundary.
 */
import { createHash, randomUUID } from "node:crypto";

export interface BridgeConfig {
  apiKey: string;
  sandbox: boolean;
}

export class BridgeApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly body: unknown,
    public readonly requestId: string | null,
    message?: string,
  ) {
    super(message ?? `Bridge API error ${status} (request-id: ${requestId ?? "n/a"})`);
    this.name = "BridgeApiError";
  }
}

// ---------------------------------------------------------------------------
// Customers
// ---------------------------------------------------------------------------

/** ISO 3166-1 alpha-3 country ("USA"), ISO 3166-2 subdivision ("CA"). */
export interface BridgeAddress {
  street_line_1: string;
  street_line_2?: string;
  city: string;
  subdivision?: string;
  postal_code?: string;
  country: string;
}

export type BridgeBusinessType = "cooperative" | "corporation" | "llc" | "other" | "partnership" | "sole_prop" | "trust";

export interface BridgeIdentifyingInformation {
  /** e.g. "ein" for a US business. */
  type: string;
  issuing_country: string;
  number?: string;
  description?: string;
  expiration?: string;
  image_front?: string;
  image_back?: string;
}

export interface BridgeAssociatedPerson {
  first_name: string;
  last_name: string;
  email: string;
  phone?: string;
  birth_date: string;
  residential_address: BridgeAddress;
  has_ownership: boolean;
  has_control: boolean;
  is_signer: boolean;
  is_director?: boolean;
  title?: string;
  ownership_percentage?: number;
  identifying_information: BridgeIdentifyingInformation[];
  [k: string]: unknown;
}

/** POST /customers with type "business". Field names exact per Bridge OpenAPI. */
export interface BusinessCustomerInput {
  type: "business";
  business_legal_name: string;
  business_trade_name?: string;
  business_description?: string;
  business_type: BridgeBusinessType;
  email: string;
  phone?: string;
  primary_website?: string;
  registered_address: BridgeAddress;
  physical_address?: BridgeAddress;
  /** NAICS codes. */
  business_industry?: string[];
  is_dao?: boolean;
  incorporation_date?: string;
  estimated_annual_revenue_usd?: string;
  account_purpose?: string;
  account_purpose_other?: string;
  source_of_funds?: string;
  high_risk_activities?: string[];
  high_risk_activities_explanation?: string;
  conducts_money_services?: boolean;
  has_foreign_tax_registration?: boolean;
  associated_persons?: BridgeAssociatedPerson[];
  identifying_information?: BridgeIdentifyingInformation[];
  /** From the hosted ToS acceptance flow. Required to create a customer. */
  signed_agreement_id?: string;
  endorsements?: string[];
  /** Correlate to Fumav's merchant record. ≤256 chars. */
  client_reference_id?: string;
  [k: string]: unknown;
}

export type BridgeCustomerStatus =
  | "active"
  | "awaiting_questionnaire"
  | "awaiting_ubo"
  | "deposits_restricted"
  | "incomplete"
  | "not_started"
  | "offboarded"
  | "paused"
  | "rejected"
  | "under_review";

export interface BridgeEndorsement {
  name: string;
  status: "incomplete" | "approved" | "revoked" | string;
  requirements?: { complete?: string[]; pending?: string[]; missing?: unknown; issues?: unknown[] };
}

export interface BridgeCustomer {
  id: string;
  status: BridgeCustomerStatus | string;
  type?: string;
  email?: string;
  first_name?: string;
  client_reference_id?: string;
  has_accepted_terms_of_service?: boolean;
  endorsements?: BridgeEndorsement[];
  requirements_due?: string[];
  capabilities?: Record<string, string>;
  rejection_reasons?: unknown[];
  created_at?: string;
  updated_at?: string;
  [k: string]: unknown;
}

// ---------------------------------------------------------------------------
// External accounts
// ---------------------------------------------------------------------------

/** POST /customers/{id}/external_accounts — US bank. */
export interface ExternalAccountInput {
  currency: "usd";
  account_type: "us";
  bank_name: string;
  /** 3–35 printable ASCII chars. */
  account_owner_name: string;
  account_owner_type?: "individual" | "business";
  first_name?: string;
  last_name?: string;
  business_name?: string;
  account: {
    /** ≥12 digits per Bridge. */
    account_number: string;
    /** Exactly 9 digits. */
    routing_number: string;
    checking_or_savings?: "checking" | "savings";
  };
  address: {
    street_line_1: string;
    street_line_2?: string;
    city: string;
    /** ISO 3166-2, e.g. "CA". */
    state: string;
    postal_code: string;
    /** Alpha-3, e.g. "USA". */
    country: string;
  };
}

export interface BridgeExternalAccount {
  id: string;
  customer_id?: string;
  account_type?: string;
  currency?: string;
  account_owner_name?: string;
  bank_name?: string;
  active?: boolean;
  beneficiary_address_valid?: boolean;
  account?: { last_4?: string; routing_number?: string; checking_or_savings?: string };
  created_at?: string;
  [k: string]: unknown;
}

// ---------------------------------------------------------------------------
// Wallets
// ---------------------------------------------------------------------------

export type BridgeChain = "base" | "ethereum" | "solana" | "tempo" | "tron" | "xdc";

export interface BridgeWalletBalance {
  balance: string;
  currency: string;
  chain?: string;
  contract_address?: string;
}

export interface BridgeWallet {
  id: string;
  chain: string;
  address: string;
  balances?: BridgeWalletBalance[];
  initiation_required?: boolean;
  created_at?: string;
  updated_at?: string;
  [k: string]: unknown;
}

// ---------------------------------------------------------------------------
// Transfers
// ---------------------------------------------------------------------------

export type BridgePaymentRail =
  | "ach"
  | "ach_push"
  | "ach_same_day"
  | "wire"
  | "fednow"
  | "bridge_wallet"
  | "sepa"
  | "swift"
  | "ethereum"
  | "solana"
  | "base"
  | "polygon"
  | "stellar"
  | "tron";

export type BridgeCurrency = "usd" | "usdc" | "usdb" | "usdt" | "pyusd" | "eur";

/** POST /transfers. Amount is a decimal string; build with usdStringFromCents(). */
export interface TransferInput {
  amount: string;
  /** The customer this transfer is for. Prefunded-wallet pattern: the MERCHANT, not the wallet owner. */
  on_behalf_of: string;
  /** = PaymentIntent.id — our reconciliation key on Bridge's side. ≤256 chars. */
  client_reference_id?: string;
  developer_fee?: string;
  source: {
    payment_rail: BridgePaymentRail;
    currency: BridgeCurrency;
    bridge_wallet_id?: string;
    external_account_id?: string;
    from_address?: string;
  };
  destination: {
    payment_rail: BridgePaymentRail;
    currency: BridgeCurrency;
    external_account_id?: string;
    to_address?: string;
    /** ≤10 chars, A–Z a–z 0–9 and spaces. */
    ach_reference?: string;
    wire_message?: string;
  };
  features?: { flexible_amount?: boolean; static_template?: boolean; allow_any_from_address?: boolean };
}

/** Always forward: awaiting_funds → funds_received → payment_submitted → payment_processed. */
export type BridgeTransferState =
  | "awaiting_funds"
  | "in_review"
  | "funds_received"
  | "payment_submitted"
  | "payment_processed"
  | "undeliverable"
  | "returned"
  | "refunded"
  | "refund_in_flight"
  | "refund_failed"
  | "canceled"
  | "error"
  | "missing_return_policy";

export interface BridgeTransfer {
  id: string;
  state: BridgeTransferState | string;
  amount?: string;
  on_behalf_of?: string;
  client_reference_id?: string;
  source?: Record<string, unknown>;
  destination?: Record<string, unknown>;
  receipt?: Record<string, unknown>;
  source_deposit_instructions?: Record<string, unknown>;
  created_at?: string;
  updated_at?: string;
  [k: string]: unknown;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Integer cents → Bridge decimal string ("1939" → "19.39"). The ONLY place cents become dollars here. */
export function usdStringFromCents(cents: number): string {
  if (!Number.isInteger(cents) || cents < 0) {
    throw new Error(`usdStringFromCents: expected non-negative integer cents, got ${cents}`);
  }
  return (cents / 100).toFixed(2);
}

/**
 * Deterministic, UUID-shaped Idempotency-Key from a stable scope string (e.g. `settle:${paymentIntentId}`).
 * Same scope → same key → Bridge returns the original result instead of moving money twice.
 */
export function idempotencyKeyFor(scope: string): string {
  const h = createHash("sha256").update(scope).digest("hex").slice(0, 32).split("");
  h[12] = "4"; // version nibble
  h[16] = "89ab"[parseInt(h[16], 16) % 4]; // variant
  const s = h.join("");
  return `${s.slice(0, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}-${s.slice(16, 20)}-${s.slice(20)}`;
}

function unwrapList<T>(raw: unknown): T[] {
  if (Array.isArray(raw)) return raw as T[];
  if (raw && typeof raw === "object" && Array.isArray((raw as { data?: unknown }).data)) {
    return (raw as { data: T[] }).data;
  }
  return [];
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

export class BridgeClient {
  private readonly base: string;

  constructor(private readonly config: BridgeConfig) {
    this.base = config.sandbox ? "https://api.sandbox.bridge.xyz/v0" : "https://api.bridge.xyz/v0";
  }

  private async request<T>(
    method: "GET" | "POST" | "PUT" | "DELETE",
    path: string,
    opts: { body?: unknown; idempotencyKey?: string } = {},
  ): Promise<T> {
    const headers: Record<string, string> = {
      "Api-Key": this.config.apiKey,
      Accept: "application/json",
    };
    if (opts.body !== undefined) headers["Content-Type"] = "application/json";
    if (method === "POST") headers["Idempotency-Key"] = opts.idempotencyKey ?? randomUUID();

    const res = await fetch(`${this.base}${path}`, {
      method,
      headers,
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    });
    const requestId = res.headers.get("x-request-id") ?? res.headers.get("request-id");
    const text = await res.text();
    let json: unknown = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = text;
    }
    if (!res.ok) throw new BridgeApiError(res.status, json, requestId);
    return json as T;
  }

  // ---- Terms of service --------------------------------------------------

  /**
   * Hosted ToS acceptance link. The person accepts on Bridge's page; Bridge redirects to `redirectUri`
   * with `?signed_agreement_id=`. Required before a customer can be created.
   */
  async createTosLink(redirectUri?: string): Promise<{ url: string }> {
    const qs = redirectUri ? `?redirect_uri=${encodeURIComponent(redirectUri)}` : "";
    const raw = await this.request<{ url?: string; data?: { url?: string } }>("POST", `/customers/tos_links${qs}`, { body: {} });
    const url = raw.url ?? raw.data?.url;
    if (!url) throw new BridgeApiError(200, raw, null, "tos_links: no url in response");
    return { url };
  }

  /** Hosted ToS page for an EXISTING customer. Acceptance flips customer.has_accepted_terms_of_service — poll it. */
  async getTosAcceptanceLink(customerId: string): Promise<{ url: string }> {
    const raw = await this.request<{ url?: string; data?: { url?: string } }>(
      "GET",
      `/customers/${encodeURIComponent(customerId)}/tos_acceptance_link`,
    );
    const url = raw.url ?? raw.data?.url;
    if (!url) throw new BridgeApiError(200, raw, null, "tos_acceptance_link: no url in response");
    return { url };
  }

  // ---- Customers --------------------------------------------------------

  createCustomer(input: BusinessCustomerInput, idempotencyKey?: string): Promise<BridgeCustomer> {
    return this.request<BridgeCustomer>("POST", "/customers", { body: input, idempotencyKey });
  }

  getCustomer(id: string): Promise<BridgeCustomer> {
    return this.request<BridgeCustomer>("GET", `/customers/${encodeURIComponent(id)}`);
  }

  /** SANDBOX ONLY. Approves KYC/KYB and any pending endorsements so the customer can transfer. */
  simulateKycApproval(customerId: string): Promise<{ success?: boolean; customer_id?: string; kyc_status?: string; message?: string }> {
    return this.request("POST", `/customers/${encodeURIComponent(customerId)}/simulate_kyc_approval`, { body: {} });
  }

  // ---- Associated persons (UBOs / control persons) ------------------------

  async listAssociatedPersons(customerId: string): Promise<Array<Record<string, unknown> & { id: string }>> {
    const raw = await this.request<unknown>("GET", `/customers/${encodeURIComponent(customerId)}/associated_persons`);
    return unwrapList(raw);
  }

  /** PUT (full replace) — send every field you originally supplied plus the changes. */
  updateAssociatedPerson(customerId: string, personId: string, body: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.request("PUT", `/customers/${encodeURIComponent(customerId)}/associated_persons/${encodeURIComponent(personId)}`, { body });
  }

  // ---- External accounts ------------------------------------------------

  createExternalAccount(customerId: string, input: ExternalAccountInput, idempotencyKey?: string): Promise<BridgeExternalAccount> {
    return this.request<BridgeExternalAccount>("POST", `/customers/${encodeURIComponent(customerId)}/external_accounts`, {
      body: input,
      idempotencyKey,
    });
  }

  async listExternalAccounts(customerId: string): Promise<BridgeExternalAccount[]> {
    const raw = await this.request<unknown>("GET", `/customers/${encodeURIComponent(customerId)}/external_accounts`);
    return unwrapList<BridgeExternalAccount>(raw);
  }

  // ---- Wallets ----------------------------------------------------------

  createWallet(customerId: string, chain: BridgeChain, idempotencyKey?: string): Promise<BridgeWallet> {
    return this.request<BridgeWallet>("POST", `/customers/${encodeURIComponent(customerId)}/wallets`, {
      body: { chain },
      idempotencyKey,
    });
  }

  async listWallets(customerId: string): Promise<BridgeWallet[]> {
    const raw = await this.request<unknown>("GET", `/customers/${encodeURIComponent(customerId)}/wallets`);
    return unwrapList<BridgeWallet>(raw);
  }

  getWallet(customerId: string, walletId: string): Promise<BridgeWallet> {
    return this.request<BridgeWallet>(
      "GET",
      `/customers/${encodeURIComponent(customerId)}/wallets/${encodeURIComponent(walletId)}`,
    );
  }

  /** SANDBOX ONLY. Credits the wallet as if a stablecoin deposit landed. amount is a decimal string. */
  simulateDeposit(customerId: string, walletId: string, p: { amount: string; currency: BridgeCurrency }): Promise<unknown> {
    return this.request(
      "POST",
      `/customers/${encodeURIComponent(customerId)}/wallets/${encodeURIComponent(walletId)}/simulate_deposit`,
      { body: p },
    );
  }

  // ---- Transfers --------------------------------------------------------

  /** Pass an idempotencyKey derived from the PaymentIntent id for money-moving calls. */
  createTransfer(input: TransferInput, idempotencyKey?: string): Promise<BridgeTransfer> {
    return this.request<BridgeTransfer>("POST", "/transfers", { body: input, idempotencyKey });
  }

  getTransfer(id: string): Promise<BridgeTransfer> {
    return this.request<BridgeTransfer>("GET", `/transfers/${encodeURIComponent(id)}`);
  }

  async listTransfers(params: { customer_id?: string; limit?: number } = {}): Promise<BridgeTransfer[]> {
    const q = new URLSearchParams();
    if (params.customer_id) q.set("customer_id", params.customer_id);
    if (params.limit) q.set("limit", String(params.limit));
    const qs = q.toString();
    const raw = await this.request<unknown>("GET", `/transfers${qs ? `?${qs}` : ""}`);
    return unwrapList<BridgeTransfer>(raw);
  }
}
