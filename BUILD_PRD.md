# Jingle on Monad - Metropolis build plan (Oct 13, 2026)

*Locked plan for the Monad Metropolis hackathon submission (Track 02: Consumer Products & Payments). Supersedes the Sep 21 Session 4 plan. Deadline: Oct 13, 20:59 PDT. Paired session: Aanjanaye + Claude.*

## What we are submitting

Jingle is pay-by-bank for game studios. A player links a bank once and pays in one tap. The studio is paid the same second, in dollars, and is never debited for a chargeback. Behind the scenes Jingle fronts the payout from its treasury and settles on Monad; the player's ACH replenishes the treasury a day later.

Monad is the settlement layer. Every merchant payout is a `settle()` call on the `JingleSettlement` contract; every Reg E dispute is an `absorbDispute()` call that draws from an on-chain reserve so the merchant is never clawed back. Both are visible as transactions with the payment id in the event.

## What already existed (built Sep 12-17, inside the hackathon window)

`packages/core` (payment state machine + ledger), `packages/orchestrator` (engine, pricing, mock rails), `apps/api` (Express API, reconciler, pollers, snapshot, merchant view), the Astra and Bridge clients and rails, 31 tests. Repo history carries those commits.

## What this build adds (Oct 13)

1. **`contracts/`** - `JingleSettlement.sol` (settle with fee split into an on-chain reserve; absorbDispute from the reserve; events keyed by payment id) + `TestUSD.sol` (6-decimal mintable test dollar standing in for USDC on testnet). Compiled with solc-js; ABI + bytecode committed under `contracts/artifacts/`.
2. **`scripts/deploy-monad.ts`** - deploys both contracts to Monad testnet from the treasury key, mints TestUSD to the treasury, approves the settlement contract, funds the reserve. Writes `deployments/monad-testnet.json` (addresses + tx hashes, committed; no secrets).
3. **`packages/monad`** - `MonadSettlementRail` (implements `SettlementRail`: `settleToMerchant` -> `settle()` tx; `absorbDispute` -> `absorbDispute()` tx) + `MonadReaders` (tx receipt -> settlement state).
4. **Engine seam** - `SettlementRail.settleToMerchant` now receives `fee` alongside the net amount; optional `absorbDispute`. `TRANSITIONS` untouched.
5. **API** - `MONAD=true` runtime mode (mock bank leg + live Monad settlement). `POST /api/payments/:id/dispute` (demo trigger for a Reg E dispute). `GET /api/ops` (treasury, reserve, contract addresses, tx hashes).
6. **Views** - `/checkout` (player: "[Game] Pay", bank link, one tap, stopwatch to settlement), `/` (merchant: dollars only, no chain vocabulary, "settlement record" link), `/ops` (Jingle operator console: everything on-chain, dispute button).
7. **`npm run reset`** - clean demo state. **`npm run monad:check`** - chain id, treasury MON + TestUSD balances, reserve.
8. **README** as the project write-up; MIT license; AI disclosure; pre-existing components identified.

Removed from the hackathon repo: Astra live mode wiring (clients stay in the tree, identified as pre-existing and not exercised). Bridge rail stays as the production settlement adapter, not used in the demo.

## Acceptance criteria

- `npm test` green (existing 31 + new: fee seam, Monad rail in mock, dispute endpoint, view copy).
- `MOCK=true npm run dev` runs every flow with no keys.
- `MONAD=true npm run dev` + a tap on `/checkout`: payment reaches `settled` from a real Monad tx; `/` shows "Paid out" with the settlement record link; `/ops` shows the tx hash and reserve.
- "Simulate dispute" on `/ops`: second Monad tx, reserve decreases, merchant balance unchanged, payment `charged_back`, ledger shows `CHARGEBACK_ABSORBED`.
- Bank leg (mock) clears ~20s later: `replenished`, `ACH_REPLENISH` booked.
- README has contract addresses + tx hashes from the live run.

## Demo video beats (3 min max)

1. Problem (20s): webstore checkout runs on card rails: 3-6% cost, 2-3 day settlement, chargebacks land on the studio.
2. Player (40s): `/checkout`, "[Game] Pay", link bank, one tap, stopwatch stops at settlement. Player saw dollars.
3. Merchant (30s): `/`, "Paid out" in dollars, net of fee, settlement record. No crypto vocabulary.
4. Operator (50s): `/ops`, the Monad tx, the reserve, "Simulate dispute", second tx, merchant untouched. Why Monad: sub-second finality at cents of gas makes per-transaction settlement with a fee split and a dispute reserve viable at $20 ticket sizes.
5. Where it goes (30s): web3 games onboarding non-crypto players, iGaming money-in/money-out, Bridge/Coinbase licensing for the fiat legs.

## Rules that survive

Secrets never in the repo. `MOCK=true` must keep every flow runnable. Amounts in integer cents; on-chain units are 6-decimal. `TRANSITIONS` is edited deliberately, not incidentally. No em-dashes in copy.
