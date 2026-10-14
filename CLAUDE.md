# Jingle (formerly Fumav) — Agent Context

**Oct 13, 2026 — Monad Metropolis build.** Read `BUILD_PRD.md` (hackathon plan) and `README.md` first. Settlement now runs on Monad through `packages/monad` + `contracts/`; `MONAD=true` is the demo mode. Astra/Bridge below are pre-existing and not exercised in the demo. Everything else in this file still holds.

**Scope rule:** payment-flow, technical architecture, and integration contracts ONLY. Do not pull GTM/investor content into this repo's context.

**Current mission: read `BUILD_PRD.md` — the MVP-visible build (3 sessions, acceptance criteria per session). All decisions in it are locked. Pricing is now 3% or $0.35 (update code constants where they still say 40¢).**

## What this is
Pay-by-bank rail for real-money gaming. Player links bank once, pays in one tap; merchant gets USD same day. Astra = consumer ACH leg (risk-scored debit). Bridge = settlement leg (treasury wallet → USDC → merchant bank offramp, `on_behalf_of`). Crypto invisible to both sides.

## Architecture (v0.1)
- `packages/core` — domain: PaymentIntent state machine + ledger entry types. **The TRANSITIONS table is the product flow. Change it only with Aanjanaye.**
- `packages/astra` — Astra API client: user intents, OAuth (authorize URL, code exchange, refresh), user, business profiles, accounts (routing + Plaid processor token), routines, transfers
- `packages/bridge` — Bridge client (customers, ToS, associated persons, external accounts, wallets, simulate_*, transfers) + `BridgeSettlementRail` behind the SettlementRail seam (Brale/Coinbase swappable)
- `packages/orchestrator` — PaymentEngine (transitions + ledger writes, T-1 only via `AlwaysT1Risk`) + mock rails
- `apps/api` — Express: `POST /webhooks/astra` (HMAC over python-style JSON, see `astra-verify.ts`), `POST/GET /api/payments`, ledger/summary/health, pollers (Bridge 10s, Astra 60s), snapshot to `.fumav-payments.json`, merchant view at `/`. `reconcile.ts` turns rail FACTS into engine transitions in legal order (events arrive out of order). `MOCK=true` = mock rails + clockwork readers.
- `scripts/` — smoke tests, run with tsx

## Money truths encoded in core
- T1 fronting: treasury pays merchant before ACH clears; `loss_absorbed` = post-settlement ACH return (the 4 bps risk). `charged_back` = Reg E guarantee invocation. Fumav absorbs both — merchant NEVER debited.
- T4: no treasury exposure, no Bridge leg — direct payout after clearing.
- All amounts integer cents. `PaymentIntent.id` → Astra `client_correlation_id` (≤80 chars) + Bridge idempotency scope.

## Sandbox gotchas (verified from docs July 2026)
- Bridge sandbox: NO payment webhooks, NO real money, NO Plaid. Wallets testable via `simulate_deposit`; webhook handler tested via manual `POST /webhooks/{id}/send`.
- Bridge, verified live Sep 13 2026 (Session 2):
  - `POST /customers` (business) works WITHOUT `signed_agreement_id`; customer lands `awaiting_ubo`. `PUT /customers/{id}/associated_persons/{pid}` with `attested_ownership_structure_at` clears the ownership item → `incomplete`. ToS via `GET /customers/{id}/tos_acceptance_link` (person clicks Accept on compliance.sandbox.bridge.xyz) → sandbox then auto-clears `kyb_review` + `post_processing` within ~1 min → `active`, base+sepa approved. **simulate_kyc_approval was never needed.**
  - **`simulate_*` endpoints need a key with the newer scopes.** The July 2026 key (67 scopes) got `401 not_allowed` on both simulators; a key generated Sep 15 (72 scopes) works. Key scopes are frozen at creation — regenerate, don't wait for Bridge. Without funding, `POST /transfers` 400s "amount is higher than the balance of the wallet" (balance checked at creation).
  - **Session 2 AC met Sep 15 2026:** transfer `56bdbb0c-0b59-4509-b508-5ec0c154edaa`, $19.39 usdc→ach, `on_behalf_of` = merchant customer (prefunded-wallet pattern ACCEPTED with the wallet under the Fumav customer), `client_reference_id` = `pay_mu3apenq0`, created in state `in_review` with imad/omad/trace_number populated. **The sandbox DOES advance transfers:** within a minute it was `funds_received` and the wallet balance had dropped 500.00 → 480.61 usdc — so S3 polling will see real state changes, even though no webhooks fire. Created through `BridgeSettlementRail` inside `PaymentEngine.start`, which booked `TREASURY_FRONT -1939¢`. Sandbox dashboard shows prod only — `npm run check:bridge` is the sandbox view.
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
  - **Sandbox never executes ACH routines.** Routine 68c3143b (and every later one) stays `active` with 0 transfers on `/v1/routines/{id}/transfers` and `/v1/transfers` for both users, users approved, source balance-capable with $100 available. Open question for Alexis (sent Sep 15?): does the sandbox scheduler run one-time ach routines, is there a trigger/simulator for transfer outcomes and chargebacks. Until answered, the view shows "Scheduled - clearing not yet reported" for the bank-debit leg — honest, not a bug. `npm run check:astra` prints the diagnosis.
  - Local session state (ids, tokens) lives in `.fumav-state.json` (gitignored). Scripts: `smoke:astra` → `oauth:astra` → `plaid:astra` / `link:astra` → `business:astra` → `routine:astra`.

- **Session 3 AC met Sep 15 2026:** `npm run dev` (live) + `npm run pay` → payment `pay_mu3dtwv20`: real Astra routine `ebc4620c-7a9d-4a93-9469-ba20c1dbcc77` + real Bridge transfer `91ff11ea-ed51-4e74-8da8-b5f22170e7fc` (on_behalf_of merchant), Bridge advanced to `payment_processed` in ~30s, engine → `settled` with MERCHANT_PAYOUT + FEE_ACCRUED booked from the real event, visible in the merchant view with both ids; survives restart via snapshot. Webhook delivery not yet exercised live (ngrok static domain pending — user action); handler is unit-tested against python3-generated signatures.

## Product decisions (A, Jul 7 session)
- Merchant surface = REAL Fumav dashboard (own it; don't integrate into merchant's internal tools for v0.1)
- Player surface = Fumav-HOSTED checkout page for demos; embedded button in merchant page is the production target, later
- Routing = T-1 only for now, behind a `RiskDecision` interface (T-4 + Astra's real decision field come later)

## Rules
- Paired sessions only — no autonomous product building.
- `.env` never committed, secrets never in chat.
- MOCK=true must keep every flow runnable without keys.

## Commands
- `npm run dev` (API + view, port 3100; `MOCK=true npm run dev` needs no keys) · `npm run pay -- --amount 1999` (script-initiated payment) · `npm run tunnel` (ngrok, needs NGROK_DOMAIN) · `npm run typecheck` · `npm test` (31 tests: transitions, ledger, pricing, HMAC vs python3, reconciler, snapshot, mock e2e, banned words) · `npm run simulate` (mock) · live sandbox: `smoke:astra`, `oauth:astra -- --party player|business [--reauth|--code]`, `plaid:astra`, `link:astra -- --party …`, `business:astra`, `routine:astra` · Bridge: `customers:bridge`, `tos:bridge`, `setup:bridge`, `transfer:bridge`, `check:bridge`
