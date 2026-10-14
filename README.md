# Jingle - pay-by-bank for game studios, settled on Monad

**Monad Metropolis hackathon, Track 02: Consumer Products & Payments.**

A player links a bank account once and pays in one tap. The studio is paid the same second, in dollars, net of a 3% fee, and is never debited for a chargeback. Behind the scenes Jingle fronts the payout from its own treasury and settles on Monad; the player's ACH debit replenishes the treasury a day later. Neither the player nor the studio ever sees a wallet, a token, or a chain.

Why this matters: a mobile game's web store exists to escape the 30% app-store tax, and every dollar on it runs on card rails: 3-6% all-in cost, 2-3 day settlement, and chargebacks that land on the studio. Pay-by-bank removes the card cost; Monad settlement removes the wait; the on-chain dispute reserve removes the chargeback risk from the studio.

## What runs where

| Surface | URL | Who sees it | Vocabulary |
|---|---|---|---|
| Player checkout | `/checkout` | the player, inside "Starfall Pay" (white-label) | dollars, bank, order; stopwatch from tap to settlement |
| Merchant view | `/` | the studio's finance team | payouts, fees, disputes covered, "settlement record" link |
| Operator console | `/ops` | Jingle | contracts, treasury, reserve, Monad tx hashes, "Simulate Reg E dispute" |

A test enforces that the player and merchant views never contain chain vocabulary (`tests/view-copy.test.ts`).

## How Monad is used

Monad is the settlement layer. The `JingleSettlement` contract does two things, each in one transaction:

- `settle(paymentId, merchant, net, fee)`: pays the merchant `net` in a dollar token and moves `fee` into an on-chain **dispute reserve** held by the contract. Emits `Settled` keyed by the off-chain payment id, so the engine's ledger and the chain reconcile one to one. Idempotent per payment id, so a retry can never double-pay.
- `absorbDispute(paymentId, amount)`: a Reg E dispute or a post-settlement ACH return arrived. The reserve refills the treasury for what Jingle fronted. The merchant's balance is untouched. Emits `DisputeAbsorbed`. That is the chargeback guarantee, enforced by the contract rather than by a promise.

Why Monad specifically: settlement per transaction only works if finality is sub-second and gas is cents. A $19.99 game purchase cannot carry a $0.50 settlement cost or a 12-second wait at checkout. Monad's throughput and finality make per-payment settlement with a fee split and a reserve viable at consumer ticket sizes, and EVM compatibility means the contract moves to mainnet with real USDC by changing one address.

Settlement is confirmed by reading the transaction receipt (`packages/monad/src/readers.ts`); the engine books `MERCHANT_PAYOUT` and `FEE_ACCRUED` only after the receipt says `success`.

### Contracts and transactions (Monad testnet)

See `deployments/monad-testnet.json` for the live addresses and deploy transaction hashes. The operator console links every settlement and dispute transaction to the explorer.

<!-- filled in from the live run; see "Live run" below -->
| | |
|---|---|
| Chain | Monad testnet (`10143`) |
| JingleSettlement | see deployments file |
| TestUSD (6-decimal test dollar, stands in for USDC) | see deployments file |
| Treasury / operator | see deployments file |
| Demo merchant wallet | see deployments file |

## Architecture

```
player (bank)  --ACH debit (T+1)-->  Jingle treasury  --settle() on Monad, now-->  merchant
                                          ^                                           |
                                          |     fee -> dispute reserve (contract)     |
                                          +---- absorbDispute() refills treasury <----+  (merchant untouched)
```

- `packages/core`: the `PaymentIntent` state machine (`TRANSITIONS` is the product) and ledger entry types. All amounts are integer cents.
- `packages/orchestrator`: `PaymentEngine` (create, start, settlement confirmed, ACH cleared, ACH returned, chargeback) and the pricing rule (3% or $0.35). Rails are injected through two interfaces: `ConsumerRail` (bank debit) and `SettlementRail` (merchant payout).
- `packages/monad`: `MonadSettlementRail` (the `SettlementRail` on Monad via viem), receipt reader, chain config, artifact loader.
- `contracts/`: `JingleSettlement.sol`, `TestUSD.sol`, compiled with solc-js; ABI + bytecode committed under `contracts/artifacts/`.
- `apps/api`: Express API. `POST /api/payments` starts a payment; pollers read receipts; `reconcile.ts` turns rail facts into legal state transitions, idempotently and out-of-order safe; `POST /api/payments/:id/dispute` is the demo trigger for a Reg E dispute; `GET /api/ops` serves the console. Snapshot persistence survives restarts.
- `packages/astra`, `packages/bridge`: the production bank-debit (Astra: KYC, Plaid link, ACH) and fiat-settlement (Bridge, a Stripe company) adapters. Pre-existing, kept in the tree, not exercised in this demo (see below).

Runtime modes: `MOCK=true` (no keys, no network; every flow runs on clockwork readers), `MONAD=true` (mock bank leg + live settlement on Monad), `MOCK=false` (live Astra + Bridge, not part of this submission).

## Stack

TypeScript, Node 20+, Express 5, viem 2, Solidity 0.8.28 via solc-js, node:test. No database (JSON snapshot), no framework on the front end (three static pages).

## Setup

```bash
git clone https://github.com/AanjanayeFumav/jingle-metropolis.git && cd jingle-metropolis
npm install
npm test                 # 36 tests: state machine, ledger fates, pricing, reconciler, mock e2e, dispute, rail units, view copy
npm run dev              # MOCK mode, no keys: http://localhost:3100/checkout
```

Live settlement on Monad testnet:

```bash
cp .env.example .env     # set MONAD_PRIVATE_KEY (a fresh key; fund it with testnet MON at https://faucet.monad.xyz)
npm run compile:contracts
npm run deploy:monad     # deploys TestUSD + JingleSettlement, mints 10,000 tUSD, approves, funds a $500 reserve -> deployments/monad-testnet.json
npm run monad:check      # chain id, balances, reserve
npm run dev:monad        # http://localhost:3100/checkout -> tap pay -> /ops shows the Monad tx
npm run reset            # forget demo payments (stop the API first)
```

Demo script: open `/checkout`, link a bank (sandbox picker), tap **Pay $19.99**. The stopwatch runs from tap to the settlement receipt. Open `/` for the studio's view and `/ops` for the Monad side; press **Simulate Reg E dispute** to watch the reserve absorb it in a second transaction while the merchant's balance stays put. About 20 seconds later the (simulated) bank debit clears and the treasury is replenished.

## Live run

<!-- filled in after the recorded run -->
Transaction hashes from the recorded demo are listed in `deployments/monad-testnet.json` (deploy) and in the demo video (settle + dispute).

## Pre-existing code and build window

This repository continues `fumav-mvp`, which was started on **September 12, 2026**, inside the hackathon window (September 1 to October 13). The commit history is intact. Built September 12-17: `packages/core`, `packages/orchestrator`, `packages/astra`, `packages/bridge`, `apps/api` (API, reconciler, pollers, snapshot, merchant view) and 31 tests, all against Astra and Bridge sandboxes.

Built October 13 for Metropolis: everything under `contracts/` and `packages/monad/`, the `MONAD` runtime mode, the dispute trigger and operator API, the fee split in the settlement seam, the player checkout, the operator console, the merchant view's settlement records, the deploy/check/reset scripts, and 5 new tests.

External libraries: `viem` (MIT), `express` (MIT), `dotenv` (BSD-2), `solc` (MIT), `tsx` (MIT), `typescript` (Apache-2.0). The contracts use no external Solidity dependencies.

## AI disclosure

Built in a paired session with Claude (Anthropic) via Claude Code, with the founder directing product decisions, architecture, and copy; Claude wrote most of the code under that direction. The state machine, pricing, and the chargeback-guarantee economics are the founder's design.

## Where this goes

- Web3 game studios: onboard players who do not identify as crypto users with a bank-linked checkout, and still settle on-chain.
- Real-money and iGaming operators: money in and money out on the same rail, with same-second settlement and no chargeback exposure.
- Production fiat legs: Astra (consumer ACH + risk) and Bridge (settlement to bank, licensed in all US states) are already integrated behind the same two interfaces; Coinbase CDP is a drop-in alternative for the on-chain treasury.

## License

MIT. See `LICENSE`.
