/**
 * @fumav/astra — thin, typed client for Astra's sandbox/production API.
 * Consumer ACH leg: user intents → OAuth → linked accounts → routines → transfers.
 *
 * Auth model (two layers):
 *  - Client-level: HTTP Basic (client_id:client_secret) — user intents, business profiles, token exchange.
 *  - User-level:   Bearer access_token from OAuth — user profile, accounts, routines, transfers.
 *
 * Hosts (verified against docs.astra.finance, Sep 2026):
 *  - API:    api-sandbox.astra.finance        | api.astra.finance
 *  - Secure: secure.api-sandbox.astra.finance | secure.api.astra.finance   (account/card creation ONLY)
 *  - OAuth:  app-sandbox.astra.finance        | app.astra.finance          (/login/oauth/authorize)
 *
 * Field names are exact per Astra's OpenAPI. Routine amounts are USD floats — convert from
 * Fumav's integer cents ONLY via usdFromCents() at this boundary, nowhere else.
 */

export interface AstraConfig {
  clientId: string;
  clientSecret: string;
  sandbox: boolean;
  /** Override the OAuth web host, e.g. "https://app.astra.finance". Defaults per `sandbox`. */
  oauthHost?: string;
}

export class AstraApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly body: unknown,
    public readonly requestId: string | null,
    message?: string,
  ) {
    super(message ?? `Astra API error ${status} (request-id: ${requestId ?? "n/a"})`);
    this.name = "AstraApiError";
  }
}

// ---------------------------------------------------------------------------
// Users
// ---------------------------------------------------------------------------

/** POST /v1/user_intent — required fields per OpenAPI spec. */
export interface UserIntentInput {
  email: string;
  /** US format, exactly +1XXXXXXXXXX */
  phone: string;
  first_name: string;
  last_name: string;
  /** No PO boxes. */
  address1: string;
  /** Astra 400s on null — send empty string when absent. */
  address2?: string;
  city: string;
  /** Two-letter state. */
  state: string;
  /** Five digits. */
  postal_code: string;
  /** YYYY-MM-DD. ≥18 years old. Note: YYYY-01-01 triggers sandbox rejection. */
  date_of_birth: string;
  /** Last four digits. */
  ssn: string;
  /** Public IP. 127.x/VPN can reject. 192.0.2.0 is Astra's sanctioned test value. */
  ip_address: string;
  kyc_type?: "receive-only" | "unverified" | "verified";
  /** Correlate to Fumav records. Keys [a-zA-Z0-9_.-], ≤25 keys. */
  metadata?: Record<string, string>;
}

export interface UserIntentCreated {
  id: string;
}

export type AstraUserStatus = "approved" | "pending" | "retry" | "document" | "suspended" | "rejected";

/** GET /v1/user (Bearer). Same shape for personal and business users. */
export interface AstraUser {
  id: string;
  email?: string;
  phone?: string;
  first_name?: string;
  last_name?: string;
  status: AstraUserStatus | string;
  rejection_reasons?: unknown;
  kyc_type?: string;
  metadata?: Record<string, string>;
  [k: string]: unknown;
}

// ---------------------------------------------------------------------------
// OAuth
// ---------------------------------------------------------------------------

/** POST /v1/oauth/token response. Access token lives 2h (default 7200s), refresh token 10 days. */
export interface TokenResponse {
  access_token: string;
  refresh_token: string;
  /** Seconds from issue until access_token expires. */
  expires_in: number;
  token_type: string;
}

export interface AuthorizeUrlParams {
  /** Must match the Redirect URI saved in the Astra developer dashboard. */
  redirectUri: string;
  /** Pre-fills the player's profile (personal onboarding). */
  userIntentId?: string;
  /** Re-authorize an existing user. */
  userId?: string;
  /** Business onboarding: business=true + business_profile_id. */
  businessProfileId?: string;
  /** 10-digit format, e.g. 5557771234. */
  phone?: string;
  phoneReadOnly?: boolean;
  /** Opaque value echoed back on the redirect — use it as a CSRF nonce. */
  state?: string;
}

// ---------------------------------------------------------------------------
// Business profiles
// ---------------------------------------------------------------------------

export type BusinessType = "soleProprietorship" | "corporation" | "llc" | "nonprofit" | "partnership";

/** POST /v1/business_profile (Basic auth). Sandbox: EIN 11-1111111 auto-approves. */
export interface BusinessProfileInput {
  /** ^\+\d{11}$ — the phone the business admin authenticates with in the OAuth module. */
  phone: string;
  email?: string;
  first_name?: string;
  last_name?: string;
  user_id?: string;
  kyb_type?: "verified" | "unverified" | "receive-only";
  business_info: {
    business_name: string;
    dba?: string;
    business_type: BusinessType;
    address1: string;
    address2?: string;
    city: string;
    state: string;
    postal_code: string;
    /** Undocumented enum — Astra's 400 lists the valid values. */
    business_classification: string;
    /** Undocumented enum — Astra's 400 lists the valid values. */
    industry_classification: string;
    /** XX-XXXXXXX. Required unless soleProprietorship. */
    ein?: string;
  };
  business_admin: {
    first_name: string;
    last_name: string;
    email: string;
    /** Required for soleProprietorship. */
    date_of_birth?: string;
    ssn?: string;
  };
  /** Required when business_type !== soleProprietorship. */
  business_controller?: {
    first_name: string;
    last_name: string;
    email: string;
    title: string;
    date_of_birth: string;
    address1: string;
    address2?: string;
    city: string;
    state: string;
    postal_code: string;
    ssn?: string;
  };
  beneficial_owners?: unknown[];
}

export interface BusinessProfileCreated {
  /** Pass as business_profile_id in the OAuth module URL. */
  id: string;
}

// ---------------------------------------------------------------------------
// Accounts
// ---------------------------------------------------------------------------

/** POST /v1/accounts/processor_token (Bearer). The Astra×Plaid path — yields a balance-capable account. */
export interface AccountByProcessorTokenInput {
  /** From Plaid /processor/token/create with processor "astra". */
  processor_token: string;
  /** Plaid institution_id, used by Astra as a fallback association. */
  institution_id?: string;
}

export interface AccountByProcessorTokenCreated {
  id: string;
  institution_id?: string;
}

/** POST {secure}/v1/accounts/create (Bearer). All fields required. */
export interface AccountByRoutingInput {
  /** From the Astra dashboard. */
  institution_id: string;
  /** Internal label. */
  name: string;
  bank_account_type: "checking" | "savings";
  /** 7–17 digits (zero-pad shorter). Never a real account number in sandbox. */
  account_number: string;
  /** Exactly 9 digits. Sandbox test value: 222222226. */
  routing_number: string;
}

export interface AstraAccount {
  id: string;
  name?: string;
  official_name?: string;
  mask?: string;
  institution_name?: string;
  type?: string;
  subtype?: string;
  connection_status?: string;
  [k: string]: unknown;
}

// ---------------------------------------------------------------------------
// Routines & transfers
// ---------------------------------------------------------------------------

/**
 * POST /v1/routines (Bearer = SOURCE user's token).
 * `payment_type: "ach"` is a bank pull — that is Fumav's leg; its client_correlation_id allows 80 chars.
 * ("debit" means debit CARD in Astra's vocabulary and caps the correlation id at 8 chars.)
 */
export interface RoutineInput {
  type: "one-time" | "recurring";
  name: string;
  /** Player's bank account id. */
  source_id: string;
  /** Fumav's (business user's) bank account id. */
  destination_id: string;
  /** Required when destination_id belongs to a different user than the bearer. */
  destination_user_id?: string;
  /** USD, float. Build with usdFromCents(). */
  amount: number;
  payment_type: "ach" | "debit" | "ledger";
  /** Where Astra exposes settlement speed — maps to Fumav's T-1 / T-4 window. */
  preferred_settlement_speed?: "T+1" | "T+2" | "T+4";
  /** = PaymentIntent.id (≤80 chars for ach). Lands in ACH addenda — the reconciliation key. */
  client_correlation_id?: string;
  /** Pacific-time date-time; defaults to today. */
  start_date?: string;
  frequency?: "weekly" | "bi-weekly" | "monthly";
}

export type RoutineStatus =
  | "requires_user_verification"
  | "pending_account_authorization"
  | "user_suspended"
  | "active"
  | "inactive"
  | "cancelled"
  | "failed"
  | "completed";

export interface AstraRoutine {
  id: string;
  status: RoutineStatus | string;
  type: string;
  name?: string;
  payment_type?: string;
  source_id?: string;
  destination_id?: string;
  destination_user_id?: string;
  amount?: number;
  preferred_settlement_speed?: string;
  client_correlation_id?: string;
  active?: boolean;
  created?: string;
  [k: string]: unknown;
}

/** GET /v1/transfers/{id}. status: pending | processed | cancelled | failed. */
export interface AstraTransfer {
  id: string;
  status?: "pending" | "processed" | "cancelled" | "failed" | string;
  routine_id?: string;
  routine_type?: string;
  amount?: number;
  payment_type?: string;
  source_id?: string;
  destination_id?: string;
  destination_user_id?: string;
  client_correlation_id?: string;
  failure_reason?: string | null;
  /** Present once a Reg E dispute exists; Astra runs the dispute (status e.g. Open / Won / Lost / Not Disputed). */
  chargeback?: Record<string, unknown> | null;
  initiated?: string;
  updated?: string;
  estimated_clearing_date?: string;
  [k: string]: unknown;
}

/** Integer cents → USD float for Astra's `amount` fields. The ONLY place cents become dollars. */
export function usdFromCents(cents: number): number {
  if (!Number.isInteger(cents) || cents < 0) {
    throw new Error(`usdFromCents: expected non-negative integer cents, got ${cents}`);
  }
  return Number((cents / 100).toFixed(2));
}

/** Astra list endpoints vary between a bare array and {items|data|<plural>: []}. */
function unwrapList<T>(raw: unknown, key: string): T[] {
  if (Array.isArray(raw)) return raw as T[];
  if (raw && typeof raw === "object") {
    const o = raw as Record<string, unknown>;
    for (const k of [key, "items", "data", "results"]) {
      if (Array.isArray(o[k])) return o[k] as T[];
    }
  }
  return [];
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

export class AstraClient {
  private readonly base: string;
  private readonly secureBase: string;
  private readonly oauthHost: string;

  constructor(private readonly config: AstraConfig) {
    this.base = config.sandbox ? "https://api-sandbox.astra.finance" : "https://api.astra.finance";
    this.secureBase = config.sandbox
      ? "https://secure.api-sandbox.astra.finance"
      : "https://secure.api.astra.finance";
    this.oauthHost =
      config.oauthHost ?? (config.sandbox ? "https://app-sandbox.astra.finance" : "https://app.astra.finance");
  }

  private basicAuth(): string {
    const raw = `${this.config.clientId}:${this.config.clientSecret}`;
    return `Basic ${Buffer.from(raw, "utf8").toString("base64")}`;
  }

  private async request<T>(
    method: string,
    path: string,
    opts: { body?: unknown; bearer?: string; secure?: boolean } = {},
  ): Promise<T> {
    const res = await fetch(`${opts.secure ? this.secureBase : this.base}${path}`, {
      method,
      headers: {
        Authorization: opts.bearer ? `Bearer ${opts.bearer}` : this.basicAuth(),
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    });
    const requestId = res.headers.get("request-id");
    const text = await res.text();
    let json: unknown = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = text;
    }
    if (!res.ok) {
      throw new AstraApiError(res.status, json, requestId);
    }
    return json as T;
  }

  // ---- OAuth ------------------------------------------------------------

  /** Build the hosted OAuth module URL. Open it in a browser; Astra redirects back with ?code=&state=. */
  authorizeUrl(p: AuthorizeUrlParams): string {
    const u = new URL("/login/oauth/authorize", this.oauthHost);
    u.searchParams.set("client_id", this.config.clientId);
    u.searchParams.set("redirect_uri", p.redirectUri);
    u.searchParams.set("response_type", "code");
    if (p.userIntentId) u.searchParams.set("user_intent_id", p.userIntentId);
    if (p.userId) u.searchParams.set("user_id", p.userId);
    if (p.businessProfileId) {
      u.searchParams.set("business", "true");
      u.searchParams.set("business_profile_id", p.businessProfileId);
    }
    if (p.phone) {
      u.searchParams.set("phone", p.phone);
      if (p.phoneReadOnly) u.searchParams.set("phone_read_only", "true");
    }
    if (p.state) u.searchParams.set("state", p.state);
    return u.toString();
  }

  private async tokenRequest(params: Record<string, string>): Promise<TokenResponse> {
    const res = await fetch(`${this.base}/v1/oauth/token`, {
      method: "POST",
      headers: {
        Authorization: this.basicAuth(),
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
      },
      body: new URLSearchParams(params),
    });
    const json = (await res.json()) as Record<string, unknown>;
    if (!res.ok) throw new AstraApiError(res.status, json, res.headers.get("request-id"));
    return json as unknown as TokenResponse;
  }

  /** Exchange an OAuth authorization_code for tokens (form-encoded, Basic auth). */
  exchangeAuthorizationCode(code: string, redirectUri: string): Promise<TokenResponse> {
    return this.tokenRequest({ grant_type: "authorization_code", code, redirect_uri: redirectUri });
  }

  /** Refresh an access token. Astra requires redirect_uri on this grant too. */
  refreshAccessToken(refreshToken: string, redirectUri: string): Promise<TokenResponse> {
    return this.tokenRequest({ grant_type: "refresh_token", refresh_token: refreshToken, redirect_uri: redirectUri });
  }

  // ---- Users ------------------------------------------------------------

  /** Create a UserIntent (client auth). Store the returned id on the player record. */
  createUserIntent(input: UserIntentInput): Promise<UserIntentCreated> {
    // Astra rejects null address2 — normalize to empty string.
    const payload = { address2: "", ...input };
    return this.request<UserIntentCreated>("POST", "/v1/user_intent", { body: payload });
  }

  /** Get a UserIntent (client auth) — includes status; user_id appears once converted_to_user. */
  getUserIntent(id: string): Promise<Record<string, unknown>> {
    return this.request("GET", `/v1/user_intent/${encodeURIComponent(id)}`);
  }

  /** The authenticated user's profile (Bearer). Works for personal and business users. */
  getUser(bearer: string): Promise<AstraUser> {
    return this.request<AstraUser>("GET", "/v1/user", { bearer });
  }

  // ---- Business profiles ------------------------------------------------

  /** Pre-create a business (client auth); then send the admin through the OAuth module with the returned id. */
  createBusinessProfile(input: BusinessProfileInput): Promise<BusinessProfileCreated> {
    return this.request<BusinessProfileCreated>("POST", "/v1/business_profile", { body: input });
  }

  getBusinessProfile(id: string): Promise<Record<string, unknown>> {
    return this.request("GET", `/v1/business_profile/${encodeURIComponent(id)}`);
  }

  // ---- Accounts ---------------------------------------------------------

  /** Link a bank by account + routing number. Hits the SECURE host. Bearer = owning user. */
  createAccountByRouting(bearer: string, input: AccountByRoutingInput): Promise<AstraAccount> {
    return this.request<AstraAccount>("POST", "/v1/accounts/create", { body: input, bearer, secure: true });
  }

  /** Link a bank via a Plaid processor token. Regular host by default; pass secure:true if Astra 404s. */
  createAccountByProcessorToken(
    bearer: string,
    input: AccountByProcessorTokenInput,
    opts: { secure?: boolean } = {},
  ): Promise<AccountByProcessorTokenCreated> {
    return this.request<AccountByProcessorTokenCreated>("POST", "/v1/accounts/processor_token", {
      body: input,
      bearer,
      secure: opts.secure,
    });
  }

  async listAccounts(bearer: string): Promise<AstraAccount[]> {
    const raw = await this.request<unknown>("GET", "/v1/accounts", { bearer });
    return unwrapList<AstraAccount>(raw, "accounts");
  }

  getAccount(bearer: string, id: string): Promise<AstraAccount> {
    return this.request<AstraAccount>("GET", `/v1/accounts/${encodeURIComponent(id)}`, { bearer });
  }

  /** Remove a linked account (soft delete on Astra's side). */
  deleteAccount(bearer: string, id: string): Promise<unknown> {
    return this.request<unknown>("DELETE", `/v1/accounts/${encodeURIComponent(id)}`, { bearer });
  }

  // ---- Routines & transfers ---------------------------------------------

  /** Create a routine. Bearer must be the SOURCE user's token. */
  createRoutine(bearer: string, input: RoutineInput): Promise<AstraRoutine> {
    return this.request<AstraRoutine>("POST", "/v1/routines", { body: input, bearer });
  }

  getRoutine(bearer: string, id: string): Promise<AstraRoutine> {
    return this.request<AstraRoutine>("GET", `/v1/routines/${encodeURIComponent(id)}`, { bearer });
  }

  async listRoutines(bearer: string): Promise<AstraRoutine[]> {
    const raw = await this.request<unknown>("GET", "/v1/routines", { bearer });
    return unwrapList<AstraRoutine>(raw, "routines");
  }

  /** Transfers spawned by one routine — the right primitive for polling a payment's bank-debit leg. */
  async listRoutineTransfers(bearer: string, routineId: string): Promise<AstraTransfer[]> {
    const raw = await this.request<unknown>("GET", `/v1/routines/${encodeURIComponent(routineId)}/transfers`, { bearer });
    return unwrapList<AstraTransfer>(raw, "transfers");
  }

  async listTransfers(bearer: string): Promise<AstraTransfer[]> {
    const raw = await this.request<unknown>("GET", "/v1/transfers", { bearer });
    return unwrapList<AstraTransfer>(raw, "transfers");
  }

  getTransfer(bearer: string, id: string): Promise<AstraTransfer> {
    return this.request<AstraTransfer>("GET", `/v1/transfers/${encodeURIComponent(id)}`, { bearer });
  }
}
