# BUILD PRD — Fumav MVP-Visible (Sandbox, Real Transactions)
*Handoff doc for the build session. Read CLAUDE.md first, then this. Everything here is decided — build, don't re-litigate. GTM/investor context deliberately excluded; do not go looking for it.*

## Goal

**Real transactions, visible live.** A payment initiated by a test player flows through Astra's sandbox (real ACH objects) and Bridge's sandbox (schema-true, simulated money), and appears in a merchant view reading live data. NOT production, NOT real money. Success = a watcher says "that's a real system."

Why: two market sources (Stash CGO + founder's own read, Sep 9) said frontend demos no longer suffice.

## What exists (inventory)

- `packages/core` — PaymentIntent state machine + ledger types. **First task: update pricing constants to rate 0.03 / floorCents 35** (code still has old 40¢ floor; locked pricing is 3% or $0.35)
- `packages/core/src/rails.ts` — ConsumerRail / SettlementRail / RiskEngine seams. Bridge implements SettlementRail behind the seam (vendor must stay swappable)
- `packages/astra` — typed client: `createUserIntent` (exact fields verified vs their OpenAPI), `getUserIntent`, `exchangeAuthorizationCode`
- `packages/orchestrator` — PaymentEngine (transitions + ledger writes) + mock rails
- `scripts/smoke-astra.ts` — ready; never run. `scripts/simulate.ts` — works, mock-only
- `.env` — Astra client id/secret + Bridge sk-test set. `SMOKE_PHONE` = founder's cell
- `Astro_Pay_Demo.html` — superseded visual demo; ignore

## Locked decisions (do not reopen)

T-1 only, behind the RiskEngine stub · per-merchant wallet + daily-sweep model (in sandbox: display-level) · payment custody ≠ loot custody · crypto invisible in all UI copy · pricing 3% or $0.35 · NO consumer balances, NO payouts, NO T-4, NO Game_Pay skin config, NO production keys — all explicitly out of scope.

## Session plan + acceptance criteria

### Session 1 — Astra live (2–3 hrs)
1. Fix core pricing constants (35¢ floor)
2. `npm run smoke:astra` → UserIntent created, id printed, visible in dashboard-sandbox.astra.finance → Users
3. OAuth: build the authorize-URL flow (`app.astra.finance/login/oauth/authorize` w/ user_intent_id + redirect to localhost callback), founder authenticates with real phone SMS, exchange code via existing `exchangeAuthorizationCode` → store access/refresh token
4. Link account: try Plaid processor-token path; fallback = create account via secure endpoint with routing `222222226` + fake account number
5. `POST /v1/routines` — one-time debit, $19.99, `client_correlation_id` = a Fumav payment-intent id
**AC: a real debit routine exists in Astra's sandbox, tied to a Fumav intent id, visible in their dashboard.**

### Session 2 — Bridge schema-true (2–3 hrs)
1. Bridge client in `packages/bridge`: Api-Key header + **Idempotency-Key (uuid) on every POST**
2. Create business customer → `POST /customers/{id}/simulate_kyc_approval` (sandbox-only endpoint)
3. External account (merchant bank, fake details OK) → create Bridge wallet (treasury) → `simulate_deposit` to fund it
4. `POST /transfers`: source bridge_wallet → destination ach/usd external_account, **`on_behalf_of` = merchant customer id**
**AC: customer, wallet, funded balance, and transfer objects all visible in Bridge's sandbox dashboard.** (Money is dummy — expected; say so in any demo.)

### Session 3 — Wire-up (3–4 hrs)
1. `apps/api` (express): Astra webhook receiver + HMAC verify — **gotcha: Astra signs JSON serialized python-style with `", "` / `": "` separators; verify against re-serialized payload, not raw** — ngrok for local delivery
2. Orchestrator drives the real legs: intent created → Astra routine (S1 code) → engine transition on webhook/poll → Bridge transfer (S2 code) → ledger entries from REAL events
3. Merchant view (reuse demo's dashboard aesthetic) reading the engine's ledger populated by live sandbox data
**AC: one command starts api + view; a script-initiated payment flows through both sandboxes and appears in the merchant view with real object ids.**

## Sandbox gotchas (verified from docs; will bite if ignored)

- Astra: max **3 UserIntents per email** (rotate plus-tags) · `address2` must be `""` never null · DOB `YYYY-01-01` and IPs `127.0.0.x` force rejection · `192.0.2.0` = sanctioned test IP · one phone = one User profile (delete via dashboard)
- Bridge: **no payment webhooks fire in sandbox** (poll transfer states; test the webhook handler with `POST /webhooks/{id}/send`) · **Plaid does not work in Bridge sandbox** · wallets ARE properly testable via `simulate_deposit`
- Astra OAuth requires SMS to `SMOKE_PHONE` — founder must be present for step S1.3 (paired session)

## Reference

`../03 Research & Briefs/Integration_Brief_AstraBridge.md` has the full endpoint/auth writeup. API docs: docs.astra.finance · apidocs.bridge.xyz (both have llms.txt indexes).
