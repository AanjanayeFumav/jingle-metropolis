# Fumav MVP — Handoff (state as of 2026-10-13)

*Self-contained brief for a fresh chat or a fresh Claude Code session. Pairs with `CLAUDE.md` (agent rules + verified sandbox facts) and `BUILD_PRD.md` (the locked session plan). Repo: https://github.com/AanjanayeFumav/fumav-mvp (private).*

## What this is
Pay-by-bank for real-money gaming. A player links a bank once and pays in one tap; the merchant receives USD the same day. Two rails behind two interfaces:
- **Astra** = consumer leg: KYC, bank link, ACH debit of the player (`packages/astra`).
- **Bridge** = settlement leg: Fumav's prefunded treasury wallet pays the merchant's bank by ACH, `on_behalf_of` the merchant (`packages/bridge`).
Fumav fronts the merchant on T-1 (pays before the player's ACH clears) and absorbs returns and Reg E chargebacks; the merchant is never debited. Pricing 3% or 35¢. Crypto never appears in any UI copy (enforced by a test).

## What exists and works (TypeScript monorepo, Node ≥20, no database)
| Layer | Path | What it does |
|---|---|---|
| Domain | `packages/core` | `PaymentIntent` state machine (`TRANSITIONS` = the product; change only with Aanjanaye), ledger entry types, rail interfaces (`ConsumerRail`, `SettlementRail`, `RiskEngine`). |
| Engine | `packages/orchestrator` | `PaymentEngine`: create → start (ACH pull → risk → front settlement) → event methods (`onSettlementConfirmed`, `onAchCleared`, `onAchReturned`, `onChargeback`) → ledger + treasury P&L. Mock rails. |
| Astra | `packages/astra` | Typed client (user intents, OAuth + refresh, business profiles, accounts via routing or Plaid processor token, routines, transfers) + `AstraConsumerRail`. |
| Bridge | `packages/bridge` | Typed client (customers, ToS, associated persons, external accounts, wallets, sandbox simulators, transfers; `Idempotency-Key` on every POST, deterministic key per payment) + `BridgeSettlementRail`. |
| API + view | `apps/api` | Express on :3100. `POST /api/payments` (single-shot start), `GET /api/payments|ledger|summary|health`, `POST /webhooks/astra` (HMAC over python-style JSON), pollers (Bridge 10s, Astra 60s), `reconcile.ts` (rail facts → legal transitions, out-of-order safe), JSON snapshot persistence, merchant view at `/`. `MOCK=true` runs the whole flow with no keys. |
| Scripts | `scripts/` | One per sandbox step (see `CLAUDE.md` → Commands). `npm run pay` is the demo trigger; `check:astra` / `check:bridge` print live state. |
| Tests | `tests/` | 31 tests: transitions, ledger fates, pricing, HMAC vs python3, reconciler, snapshot, mock end-to-end, banned words. `npm test`. |

Run it: `npm install` → `MOCK=true npm run dev` → open http://localhost:3100 → `npm run pay -- --amount 1999`. Live mode needs the local files listed below.

## What was proven live (sandboxes, real objects, simulated money)
- **S1 (Sep 12):** real Astra ACH routine `68c3143b-…`, $19.99 T+1, correlation id = a Fumav payment id. Player = Astra test phone + Plaid-sandbox bank; business = Fumav Inc (real EIN on the developer account).
- **S2 (Sep 15):** Bridge customers Fumav Inc + demo merchant "Sarena Games LLC" (both active), treasury wallet funded with 500 simulated USDC, transfer `56bdbb0c-…` $19.39 wallet→merchant bank, on_behalf_of merchant. Bridge sandbox advances transfer state on its own.
- **S3 (Sep 15):** `npm run dev` + `npm run pay` → payment `pay_mu3dtwv20` with real routine `ebc4620c-…` and real Bridge transfer `91ff11ea-…`; Bridge reached processed in ~30s, engine booked payout + fee from that event, view showed both ids, survived a restart.

## Sandbox realities that shaped the code (full list in CLAUDE.md)
- Astra's sandbox **never executes ACH routines**: routines stay `active`, zero transfers, forever. The bank-debit leg therefore never clears in demos; the view says "Scheduled - clearing not yet reported". Question for Alexis (Astra) drafted, status unknown.
- Astra webhooks need a public https URL (ngrok static domain chosen; not yet set up). The 60s poller is the fallback and works.
- Astra source accounts must be Plaid-linked; routing-number accounts are rejected as a source. Bridge sandbox simulators needed a regenerated API key (scopes are frozen per key).
- Astra OAuth refresh tokens last 10 days → both sessions in the local state file are **expired as of Oct 13**; live mode needs `npm run oauth:astra -- --party player --reauth` and `--party business --reauth` (API stopped; port 3000 is the callback).

## Open items (none are code defects)
1. ngrok account + static domain + register the webhook URL in the Astra sandbox dashboard (Aanjanaye).
2. Astra sandbox scheduler question to Alexis.
3. Ledger entry type for a Bridge payout that fails after fronting (product decision).
4. **Session 4 is scoped but not built** (BUILD_PRD.md, Sep 21): timed signup demo with a visible stopwatch, UX pass on merchant view + checkout, one-command demo reset.
5. Parked by decision: consumer prefunded balances, consumer payouts, T-4, Bridge webhooks.

## Local-only files that do NOT travel with the repo
- `.env` — `ASTRA_CLIENT_ID/SECRET`, `ASTRA_REDIRECT_URI` (localhost:3000), `BRIDGE_API_KEY` (sk-test, Sep 15 key), `PLAID_CLIENT_ID/SECRET` (sandbox, Astra integration enabled), `SMOKE_EMAIL`, `SMOKE_PHONE` (Astra test number), `BUSINESS_ADMIN_PHONE`, `ASTRA_INSTITUTION_ID`, `FUMAV_EIN`, `PORT`, `NGROK_DOMAIN`. Copy by hand; never commit.
- `.fumav-state.json` — Astra user/account ids + OAuth tokens for player and business; Bridge customer, wallet, external-account ids. Copy by hand if the new project should reuse the same sandbox objects.
- `.fumav-payments.json` — the API's payment snapshot. Disposable.
- Claude Code memory for this folder lives outside the repo; `CLAUDE.md` + this file carry everything that matters.

## Repurposing guide (e.g. a hackathon fork)
**Reusable as-is:** `packages/core` (state machine + ledger), `packages/orchestrator` (engine, mock rails), `apps/api/src/reconcile.ts`, `store.ts`, `astra-verify.ts`, the `RailReaders` mock, the test harness. These know nothing about Fumav's merchants.
**Reusable if the rails stay the same:** both clients and both rail adapters; the sandbox scripts (they read ids from the state file).
**Product-specific, expect to replace:** `apps/api/src/view.ts` labels, `public/index.html`, `DEMO_MERCHANT_ID` in `wiring.ts`, `scripts/pay.ts` defaults, pricing constant in `engine.ts`, the `BUILD_PRD.md` itself.
**Fastest path to a new demo:** keep MOCK mode green (`npm test`, `MOCK=true npm run dev`), change the view and labels first, then decide which rail legs the hackathon actually needs live.
**Rules that should survive any fork:** secrets never in the repo; `MOCK=true` must keep every flow runnable; amounts in integer cents; the transitions table is edited deliberately, not incidentally.
