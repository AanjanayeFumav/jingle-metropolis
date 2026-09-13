# Fumav — Agent Context

**Scope rule:** payment-flow, technical architecture, and integration contracts ONLY. Do not pull GTM/investor content into this repo's context.

**Current mission: read `BUILD_PRD.md` — the MVP-visible build (3 sessions, acceptance criteria per session). All decisions in it are locked. Pricing is now 3% or $0.35 (update code constants where they still say 40¢).**

## What this is
Pay-by-bank rail for real-money gaming. Player links bank once, pays in one tap; merchant gets USD same day. Astra = consumer ACH leg (risk-scored debit). Bridge = settlement leg (treasury wallet → USDC → merchant bank offramp, `on_behalf_of`). Crypto invisible to both sides.

## Architecture (v0.1)
- `packages/core` — domain: PaymentIntent state machine + ledger entry types. **The TRANSITIONS table is the product flow. Change it only with Aanjanaye.**
- `packages/astra` — Astra API client: user intents, OAuth (authorize URL, code exchange, refresh), user, business profiles, accounts (routing + Plaid processor token), routines, transfers
- `packages/bridge` — Bridge client (customers, ToS, associated persons, external accounts, wallets, simulate_*, transfers) + `BridgeSettlementRail` behind the SettlementRail seam (Brale/Coinbase swappable)
- `packages/orchestrator` — TODO: transition engine, T1/T4 routing, ledger writes
- `apps/api` — TODO: Express, webhook receivers (Astra HMAC quirk: signature computed over python-style JSON with `", "`/`": "` separators)
- `scripts/` — smoke tests, run with tsx

## Money truths encoded in core
- T1 fronting: treasury pays merchant before ACH clears; `loss_absorbed` = post-settlement ACH return (the 4 bps risk). `charged_back` = Reg E guarantee invocation. Fumav absorbs both — merchant NEVER debited.
- T4: no treasury exposure, no Bridge leg — direct payout after clearing.
- All amounts integer cents. `PaymentIntent.id` → Astra `client_correlation_id` (≤80 chars) + Bridge idempotency scope.

## Sandbox gotchas (verified from docs July 2026)
- Bridge sandbox: NO payment webhooks, NO real money, NO Plaid. Wallets testable via `simulate_deposit`; webhook handler tested via manual `POST /webhooks/{id}/send`.
- Bridge, verified live Sep 13 2026 (Session 2):
  - `POST /customers` (business) works WITHOUT `signed_agreement_id`; customer lands `awaiting_ubo`. `PUT /customers/{id}/associated_persons/{pid}` with `attested_ownership_structure_at` clears the ownership item → `incomplete`. ToS via `GET /customers/{id}/tos_acceptance_link` (person clicks Accept on compliance.sandbox.bridge.xyz) → sandbox then auto-clears `kyb_review` + `post_processing` within ~1 min → `active`, base+sepa approved. **simulate_kyc_approval was never needed.**
  - **Both `simulate_*` endpoints return `401 not_allowed` on our sandbox key** (kyc approval AND wallet deposit) while every other call works. Unresolved — dashboard action / new key / ask Bridge. Without `simulate_deposit` the wallet stays 0 and `POST /transfers` 400s: "amount is higher than the balance of the wallet" (balance is checked at creation, not deferred to awaiting_funds).
  - External accounts (`POST /customers/{id}/external_accounts`, account_number ≥12 digits) require an approved endorsement (`403 missing_required_endorsements` before). Wallet creation requires ToS (`400 has_not_accepted_tos`) but not the endorsement.
  - Wallets are customer-scoped (`POST /customers/{id}/wallets`, chain e.g. solana); list returns `balances[]` per stablecoin (usdc/usdb/usdt/pyusd/eurc). Our treasury wallet is under the Fumav customer; on_behalf_of = merchant was NOT rejected for ownership (only balance) — prefunded pattern looks accepted.
  - `Idempotency-Key` on every POST; for money moves we derive a UUID-shaped key from `settle:<PaymentIntent.id>` (`idempotencyKeyFor`) so retries can't double-pay.
  - Scripts: `customers:bridge` → `tos:bridge` (person accepts, script polls) → `setup:bridge` (wallet, deposit, merchant bank) → `transfer:bridge` (via BridgeSettlementRail + real PaymentIntent) → `check:bridge`. State under `bridge` in `.fumav-state.json`.
- Astra sandbox: 3 UserIntents/email max; test phones via dashboard toggle (bottom of Dashboard tab; 5 numbers, no real SMS); DOB `YYYY-01-01` and IP `127.0.0.x` force rejection; `192.0.2.0` = sanctioned test IP; `address2` must be `""` never null.
- Astra, verified live Sep 12 2026 (Session 1):
  - OAuth host `app-sandbox.astra.finance/login/oauth/authorize` works; Redirect URI must match the dashboard field; sandbox also lets you copy the code off the page (`oauth:astra -- --code`). Access token 2h, refresh 10d, refresh grant needs `redirect_uri` too.
  - Business onboarding: `POST /v1/business_profile` (EIN `11-1111111` auto-approves) → OAuth with `business=true&business_profile_id=`. API requires `business_controller.ssn` despite docs; classifications accept `"other"`. One phone = one user, so player and business need different phones.
  - Routines: `payment_type: "ach"` = bank pull (80-char correlation id). `"debit"` = debit CARD (8-char cap) — not our leg. `preferred_settlement_speed` T+1/T+2/T+4 is where the T-1/T-4 choice surfaces; `GET /v1/users/{id}/capabilities` reports `max_settlement_speed`.
  - **Source account must be balance-capable.** Accounts created by account+routing (`secure.` host, routing `222222226`) are `connected`/`approved` but Astra 400s: "Source account has no balance capabilities". The hosted connect-accounts screen is NOT shown on our sandbox client (confirmed twice). Only path: Plaid sandbox → `/processor/token/create` (processor `astra`) → `POST /v1/accounts/processor_token` (`npm run plaid:astra`, needs PLAID_CLIENT_ID/SECRET). Routing-number accounts are fine as the DESTINATION (Fumav business side).
  - Plaid sandbox keys must have the Astra integration enabled (dashboard.plaid.com → Developers → Integrations) or `/processor/token/create` returns `INVALID_PRODUCT`.
  - "Client is missing a business EIN" on `POST /v1/routines` = Fumav's DEVELOPER account (dashboard) lacks an EIN — a dashboard field, no API. Set Sep 12. Real EIN is `FUMAV_EIN` in `.env` (Bridge S2 needs it too).
  - **Session 1 AC met Sep 12 2026:** routine `68c3143b-c7e7-4efa-9c0d-88038cec5428`, `active`, $19.99 ach T+1, correlation `pay_mtz1mu6s0`. Transfers list was empty right after creation — Astra materializes the transfer later; S3 must poll/webhook for it.
  - `packages/astra/src/rail.ts` = `AstraConsumerRail` (real ConsumerRail; needs a playerId → token/source resolver + the business destination from state).
  - Local session state (ids, tokens) lives in `.fumav-state.json` (gitignored). Scripts: `smoke:astra` → `oauth:astra` → `plaid:astra` / `link:astra` → `business:astra` → `routine:astra`.

## Product decisions (A, Jul 7 session)
- Merchant surface = REAL Fumav dashboard (own it; don't integrate into merchant's internal tools for v0.1)
- Player surface = Fumav-HOSTED checkout page for demos; embedded button in merchant page is the production target, later
- Routing = T-1 only for now, behind a `RiskDecision` interface (T-4 + Astra's real decision field come later)

## Rules
- Paired sessions only — no autonomous product building.
- `.env` never committed, secrets never in chat.
- MOCK=true must keep every flow runnable without keys.

## Commands
- `npm run typecheck` · `npm test` (14 unit tests: transitions, ledger, pricing) · `npm run simulate` (mock) · live sandbox: `smoke:astra`, `oauth:astra -- --party player|business [--reauth|--code]`, `plaid:astra`, `link:astra -- --party …`, `business:astra`, `routine:astra` · Bridge: `customers:bridge`, `tos:bridge`, `setup:bridge`, `transfer:bridge`, `check:bridge`
