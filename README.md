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

| | |
|---|---|
| Chain | Monad testnet (`10143`) |
| JingleSettlement | [`0xa655ef5323a95cceaf81907dd945720cab2de999`](https://testnet.monadexplorer.com/address/0xa655ef5323a95cceaf81907dd945720cab2de999) |
| TestUSD (6-decimal test dollar, stands in for USDC) | [`0xf03dcc288d3d9e87b836dc57bc3688a18de86b3e`](https://testnet.monadexplorer.com/address/0xf03dcc288d3d9e87b836dc57bc3688a18de86b3e) |
| Treasury / operator | [`0x9c83aA4A8aE8bcBCD0925B298513EB8D386D86FA`](https://testnet.monadexplorer.com/address/0x9c83aA4A8aE8bcBCD0925B298513EB8D386D86FA) |
| Demo merchant wallet | [`0xc71dAFF64eCc6FAc9DE76C681092634592456459`](https://testnet.monadexplorer.com/address/0xc71dAFF64eCc6FAc9DE76C681092634592456459) |
| Deploy transactions | [deployTestUsd](https://testnet.monadexplorer.com/tx/0x8340d6013167de40d5799580e300df8d83b405d5a2b8e87d3d89ae3d691f487d), [deploySettlement](https://testnet.monadexplorer.com/tx/0x8ec61abfd88b47d63ac676964649ee7dab7847c0bac7b95e13fd208cadb00b5c), [mint](https://testnet.monadexplorer.com/tx/0x2d787dc35ed6a00697f6ba9f90dee483a26712dad05155a9dcd106fedb17637e), [approve](https://testnet.monadexplorer.com/tx/0x11fa64d23eae6a47915ef327dcc6d3f911d1ebbba6c27270bf209c67df54a1b3), [fundReserve](https://testnet.monadexplorer.com/tx/0xc6b3eb18ef0fdd37b5144c0f2efd7c6d54b478dbc40c8e5a97d022cf4a11dd9a) |

## Privy: merchant payout accounts

**Bounty: Privy.** A studio's finance lead sets up payouts with nothing but an email at `/merchant/setup`. Jingle creates a Privy server wallet for the merchant on the spot (`POST https://api.privy.io/v1/wallets`, `chain_type: "ethereum"`, app-secret auth, `privy-idempotency-key` per merchant so a retry never opens a second account), stores it in `.jingle-merchants.json`, and the next `settle()` on Monad pays that address. No seed phrase, no browser extension, no client SDK on our pages: the studio sees "Payout account ready" and a masked account number; the operator console shows "Merchant payout wallet: Privy-managed", the Privy wallet id, and its live balance with an explorer link.

- `packages/privy/src/client.ts`: a small REST client for the Privy Wallets API, plus a deterministic keyless mock used in `MOCK=true` and in tests.
- `packages/privy/src/accounts.ts`: payout accounts per merchant, idempotent (a second setup returns the existing account).
- `POST /api/merchants/:id/payout-account { email }` (201, or 200 when it already exists) and `GET /api/merchants/:id`.
- `resolveMerchant(merchantId)` in `apps/api/src/wiring.ts` reads the payout account first and falls back to the deployed demo merchant address, so settlement routes to the Privy wallet as soon as it exists.

## Privy: treasury signing through a server wallet (policy-scoped)

The operator key does not have to live in `.env`. With `TREASURY_SIGNER=privy`, the Jingle treasury is a Privy server wallet: every `settle()` and `absorbDispute()` is signed by Privy (`POST /v1/wallets/{id}/rpc`, `eth_signTransaction`) and broadcast by our own viem client, so Monad needs no Privy-side chain support. A Privy policy attached to the wallet restricts it to `JingleSettlement` on chain 10143: `settle`, `absorbDispute`, `setOperator` back to the previous treasury (rollback), and `approve` on the dollar token with the settlement contract as spender. The raw-key path stays as the default and the fallback.

- `packages/privy/src/viem-account.ts`: a viem `LocalAccount` whose `signTransaction` is Privy. Field mapping is covered by a round-trip test that recovers the signer from the returned raw transaction.
- `packages/monad/src/clients.ts`: `walletClientFor(env)` picks the Privy wallet when `TREASURY_SIGNER=privy` and `PRIVY_TREASURY_WALLET_ID` + `PRIVY_TREASURY_ADDRESS` are set.
- `npm run privy:treasury`: one-shot migration. Creates the policy and the wallet, funds it with 1 MON and 5,000 tUSD from the raw key, has Privy sign `approve(settlement, max)` as the first real signature, then `setOperator(privyAddress)`. Writes the new treasury, the Privy wallet id and policy id into `deployments/monad-testnet.json` and prints the `.env` lines to add. `-- --rollback` hands the operator role back to the raw key (signed by Privy; the policy allows exactly that target).
- `/ops` shows "Treasury signer: Privy wallet <id> · policy <id>" when active, "raw key (.env)" otherwise.
- Live: the deployed treasury is now the Privy wallet `0xF11C…bb47` under policy `mrnafbi7u4l6trqe3y5xsrbo` (see "Live run" for the signed transactions).

## Architecture

```
player (bank)  --ACH debit (T+1)-->  Jingle treasury  --settle() on Monad, now-->  merchant
                                          ^                                           |
                                          |     fee -> dispute reserve (contract)     |
                                          +---- absorbDispute() refills treasury <----+  (merchant untouched)
```

- `packages/core`: the `PaymentIntent` state machine (`TRANSITIONS` is the product) and ledger entry types. All amounts are integer cents.
- `packages/orchestrator`: `PaymentEngine` (create, start, settlement confirmed, ACH cleared, ACH returned, chargeback) and the pricing rule (3% or $0.35). Rails are injected through two interfaces: `ConsumerRail` (bank debit) and `SettlementRail` (merchant payout).
- `packages/privy`: Privy server-wallet client and merchant payout accounts (see above).
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
npm test                 # 43 tests: state machine, ledger fates, pricing, reconciler, mock e2e, dispute, rail units, Privy payout accounts and treasury signing, view copy
npm run dev              # MOCK mode, no keys: http://localhost:3100/checkout
```

Live settlement on Monad testnet:

```bash
cp .env.example .env     # set MONAD_PRIVATE_KEY (a fresh key; fund it with testnet MON at https://faucet.monad.xyz)
                         # optional: PRIVY_APP_ID + PRIVY_APP_SECRET (dashboard.privy.io); without them a mock Privy provider is used
npm run compile:contracts
npm run deploy:monad     # deploys TestUSD + JingleSettlement, mints 10,000 tUSD, approves, funds a $500 reserve -> deployments/monad-testnet.json
npm run monad:check      # chain id, balances, reserve
npm run dev:monad        # http://localhost:3100/checkout -> tap pay -> /ops shows the Monad tx
npm run reset            # forget demo payments and payout accounts (stop the API first)
npm run privy:treasury   # optional: move the operator role to a policy-scoped Privy server wallet (-- --rollback to undo)
npm run privy:policy-check  # asks the Privy treasury wallet to sign an off-scope transfer; the policy must refuse
```

Demo script: open `/merchant/setup` and create the studio's payout account with an email (Privy). Open `/checkout`, link a bank (sandbox picker), tap **Pay $19.99**. The stopwatch runs from tap to the settlement receipt. Open `/` for the studio's view and `/ops` for the Monad side; press **Simulate Reg E dispute** to watch the reserve absorb it in a second transaction while the merchant's balance stays put. About 20 seconds later the (simulated) bank debit clears and the treasury is replenished.

## Live run

Recorded on October 13, 2026 from `/checkout` and `/ops` against the contracts above (block timestamps are on the explorer):

| Payment | Outcome | `settle()` tx | Block | `absorbDispute()` tx |
|---|---|---|---|---|
| `pay_mv7dh79b0` | replenished | [`0xc4951be8…f982b6`](https://testnet.monadexplorer.com/tx/0xc4951be8ef339edf6eef85a20f546c81db21b855789c9a0c1e7658d4e8f982b6) | 70823801 | - |
| `pay_mv7dhayt4` | charged back | [`0x5a22da8d…9472c2`](https://testnet.monadexplorer.com/tx/0x5a22da8dcb0067c205bb78be3e7d3b90c98908761f8d1d9ae5659962419472c2) | 70823815 | [`0x877ef62b…f0e7d0`](https://testnet.monadexplorer.com/tx/0x877ef62bf987afe87e9f5acf6215f813b8278ff6b4c0c8a3ea8d20bf03f0e7d0) |
| `pay_mv7dhefw8` | replenished | [`0x6c52d1a6…f43ae1`](https://testnet.monadexplorer.com/tx/0x6c52d1a6ce92676fdd1947dd1a67eda8e90aedc72ca93abadb26f6f60af43ae1) | 70823830 | - |

With Privy (recorded after the two Privy parts landed, same evening):

| Payment | Outcome | `settle()` tx | Signed by | `absorbDispute()` tx |
|---|---|---|---|---|
| `pay_mv7fxfr20` | replenished, paid to the Privy merchant payout wallet `0x0CA4…5BEe` | [`0x72f32e32…4bdd49`](https://testnet.monadexplorer.com/tx/0x72f32e324b54eb252412771e73560351e98d7bc424c4c2539cd2d4800f4bdd49) | raw treasury key | - |
| `pay_mv7fyuur0` | charged back | [`0x55487bad…b43250`](https://testnet.monadexplorer.com/tx/0x55487bad019245b5ec19e61eff6a81854c58e3dac969cf12aa564d9720b43250) | Privy treasury wallet `bkl5pmmzvk0ieycjx282kwps` | [`0xc25b47d1…a1684`](https://testnet.monadexplorer.com/tx/0xc25b47d161e6dd2567d4ad12cd043d89eb2f909ca111541ea46b7078471a1684) (Privy) |

Treasury migration (`npm run privy:treasury`): policy `mrnafbi7u4l6trqe3y5xsrbo`, wallet `0xF11C160c886A61E54A5d84B1D38D3457a6A5bb47`; the first Privy-signed transaction was [`approve`](https://testnet.monadexplorer.com/tx/0x752c3b8f0bcd83e6810af268cce69cd809d96fcfc90567332e3c1194621fdeed), then [`setOperator`](https://testnet.monadexplorer.com/tx/0xa65631ac8b6559984327b945d71905e867afb477142bb9f3559a4cdb25844fe3) from the previous key. All hashes are in `deployments/monad-testnet.json`.

Each settlement reached `payment_processed` from the Monad receipt within 1 to 3 seconds of the tap; the engine then booked `MERCHANT_PAYOUT` and `FEE_ACCRUED`. The disputed payment shows `CHARGEBACK_ABSORBED` in the ledger while the merchant's on-chain balance is unchanged; the reserve dropped by $19.99.

## Pre-existing code and build window

This repository continues `fumav-mvp`, which was started on **September 12, 2026**, inside the hackathon window (September 1 to October 13). The commit history is intact. Built September 12-17: `packages/core`, `packages/orchestrator`, `packages/astra`, `packages/bridge`, `apps/api` (API, reconciler, pollers, snapshot, merchant view) and 31 tests, all against Astra and Bridge sandboxes.

Built October 13 for Metropolis: everything under `contracts/` and `packages/monad/`, the `MONAD` runtime mode, the dispute trigger and operator API, the fee split in the settlement seam, the player checkout, the operator console, the merchant view's settlement records, the deploy/check/reset scripts, the Privy merchant payout accounts and treasury signing (`packages/privy`, `/merchant/setup`, `scripts/privy-treasury.ts`), and 12 new tests.

External libraries: `viem` (MIT), `express` (MIT), `dotenv` (BSD-2), `solc` (MIT), `tsx` (MIT), `typescript` (Apache-2.0). The contracts use no external Solidity dependencies.

## AI disclosure

Built in a paired session with Claude (Anthropic) via Claude Code, with the founder directing product decisions, architecture, and copy; Claude wrote most of the code under that direction. The state machine, pricing, and the chargeback-guarantee economics are the founder's design.

## Where this goes

- Web3 game studios: onboard players who do not identify as crypto users with a bank-linked checkout, and still settle on-chain.
- Real-money and iGaming operators: money in and money out on the same rail, with same-second settlement and no chargeback exposure.
- Production fiat legs: Astra (consumer ACH + risk) and Bridge (settlement to bank, licensed in all US states) are already integrated behind the same two interfaces; Coinbase CDP is a drop-in alternative for the on-chain treasury.

## License

MIT. See `LICENSE`.
