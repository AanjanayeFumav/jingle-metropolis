# HANDOFF-METROPOLIS.md — continue the Monad Metropolis build in Claude Code

*Written Oct 13, 2026, 6:10 PM PDT by Claude (chat "Jingle Work - October"). Read this first, then `CLAUDE.md`, `BUILD_PRD.md`, `README.md`. Submission texts live outside the repo in `../SUBMISSION-FIELDS.md` and `../SUBMISSION.md`.*

## The clock

- **Deadline: Oct 13, 20:59 PDT** (hackathon.monad.xyz/project?tab=submission). Submission is editable until then; the version at the deadline is judged.
- **Hard stop for building: 7:15 PM.** After that: record demo video (3 min max) + pitch video (2 min max), upload (YouTube unlisted or Loom), deploy to Render for the "Live product" URL, paste fields, submit. Target submitted by 8:30.
- Not done yet, in order: **push the repo** (still not pushed), Privy A, Privy B (only if A is green by 6:45), videos, Render, form, submit.

## State of the repo (all committed on `main`, working tree clean)

- Local path: `~/Documents/Jingle/Jingle x Claude/jingle`. Remote still points at the old private repo; the public target is **https://github.com/AanjanayeFumav/jingle-metropolis** (empty, created by A). Push:
  `git remote set-url origin https://github.com/AanjanayeFumav/jingle-metropolis.git && git push -u origin main`
- History: 5 commits Sep 12-17 (fumav-mvp, inside the hackathon window) + 6 commits Oct 13 (plan, Monad rail + contracts, views, README/license, deployment, live hashes).
- `npm test`: 36/36. `npx tsc -p .`: clean. `MOCK=true` runs everything keyless.
- `.env` (never commit) has `MONAD_PRIVATE_KEY` (treasury `0x9c83aA4A8aE8bcBCD0925B298513EB8D386D86FA`), RPC/chain/explorer vars, `PORT=3100`. Add `PRIVY_APP_ID` / `PRIVY_APP_SECRET` there when A creates the Privy app.
- esbuild: node_modules was first installed from a Linux shell; `npm install --no-save @esbuild/darwin-arm64@0.28.1` was run so tsx works on the Mac. If tsx ever complains about esbuild platform again, rerun that line. Do not add it to package.json.
- Deployed (Monad testnet, chain 10143): `deployments/monad-testnet.json`. JingleSettlement `0xa655ef5323a95cceaf81907dd945720cab2de999`, TestUSD `0xf03dcc288d3d9e87b836dc57bc3688a18de86b3e`, merchant `0xc71dAFF64eCc6FAc9DE76C681092634592456459`, treasury minted 10,000 tUSD, reserve funded $500. Three live settlements + one on-chain dispute recorded; hashes in README "Live run".
- Views: `/checkout` (player, Starfall Pay, stopwatch), `/` (merchant, dollars only, "settlement record" link), `/ops` (operator console, Monad everything, "Simulate Reg E dispute"). `tests/view-copy.test.ts` bans chain vocabulary (including "monad", "wallet", "token", "chain") from `index.html`, `checkout.html`, `view.ts`. Keep it that way; the ops console is exempt.
- Runtime modes in `apps/api/src/wiring.ts`: `MOCK=true` (default), `MONAD=true` (mock bank leg + live Monad settlement; `npm run dev:monad`), `MOCK=false` (pre-existing Astra+Bridge, not exercised).
- Snapshot: `.jingle-payments.json` (gitignored). `npm run reset` clears it (stop the API first).

## Decisions already made (do not reopen)

- Astra is not exercised in the demo (sandbox never clears ACH; nothing a judge can see). Bank leg = mock clockwork, clears ~20 s after settlement.
- Chargeback fraud prevention is shown as a working on-chain feature (dispute reserve in the contract), not a write-up line.
- Fictional merchant "Starfall Studios" (`merch_starfall`). Name on everything: Jingle.
- Repo public, MIT. AI use disclosed in README. Pre-existing components identified in README.
- Bounties: **Privy only** tonight (A then B below). Envio and Aurora Intents go in README "Where this goes" as roadmap (Envio: index `Settled`/`DisputeAbsorbed` into a public settlement ledger studios can audit; Aurora: pay a web3 studio in its own token from the stablecoin leg). Dynamic and Alchemy: no.
- No em-dashes in any copy. Secrets never in chat or in the repo. Integer cents everywhere; 6-decimal units on-chain. `TRANSITIONS` in `packages/core` is edited deliberately, never incidentally.

## Part A — Merchant payout account through Privy (build first, ~25 min)

Story: the studio's finance lead sets up payouts with an email. Jingle creates a Privy-managed wallet for the merchant server-side; the next `settle()` pays that address. No seed phrase, no browser extension, no React SDK in our pages.

Build:
1. `packages/privy/src/client.ts`: tiny REST client. Verify the exact shape at docs.privy.io (Wallets API → Create wallet, Policies). Expected: `POST https://api.privy.io/v1/wallets`, headers `Authorization: Basic base64(PRIVY_APP_ID:PRIVY_APP_SECRET)`, `privy-app-id: PRIVY_APP_ID`, `Content-Type: application/json`, body `{ "chain_type": "ethereum" }` → `{ id, address, chain_type, ... }`. Also `POST /v1/wallets/{id}/rpc` for Part B. Mock implementation (`MOCK=true` or no `PRIVY_APP_ID`): deterministic fake id + address from a keccak of the merchant id, so `npm test` stays keyless.
2. Store: `.jingle-merchants.json` (add to .gitignore): `{ "<merchantId>": { email, privyWalletId, address, createdAt } }`.
3. API (`apps/api/src/app.ts`): `POST /api/merchants/:id/payout-account { email }` → create Privy wallet → store → 201 `{ merchantId, email, address, privyWalletId, provider: "privy" }`. `GET /api/merchants/:id` → same (404 if none). Idempotent: a second POST for the same merchant returns the existing account.
4. Wiring: `resolveMerchant(merchantId)` reads the store first, falls back to `deployment.merchant`. Expose on `Runtime` so `/api/ops` can show it.
5. Page `apps/api/public/merchant-setup.html` served at `/merchant/setup` (static, no chain words): "Set up payouts" → email field → "Create payout account" → "Payout account ready" with masked address and a link to `/`. Merchant view (`index.html`) header line: "Payout account: ••••6459 · set up with <email>" when `/api/merchants/merch_starfall` exists. Ops console: "Merchant payout wallet: Privy-managed · id <…> · balance" with explorer link.
6. Tests (`tests/privy.test.ts`): mock client creates deterministic account; POST twice is idempotent; `resolveMerchant` returns the override; view copy test still passes (no "wallet" on merchant/player pages).
7. README: new section "Privy: merchant payout accounts" + bounty line; keep "Setup" accurate (`PRIVY_APP_ID`/`PRIVY_APP_SECRET` optional; without them the mock provider is used).
8. Commit: `Privy: merchant payout accounts via server-managed wallets`.

Live check (A, in Terminal, after `.env` has the Privy keys): `npm run dev:monad` → `/merchant/setup` → email → account ready → `/checkout` → pay → `/ops` shows the settlement paid the Privy address.

## Part B — Treasury signing through Privy (only if A is green by 6:45, ~40 min)

Story: the operator key does not live in `.env`. The treasury is a Privy server wallet; every `settle()` and `absorbDispute()` is signed by Privy; a policy restricts that wallet to those two functions on JingleSettlement. Behind a flag; the raw-key path stays as fallback.

Build:
1. `packages/privy/src/viem-account.ts`: a viem local account via `toAccount({ address, signTransaction, signMessage, signTypedData })` where `signTransaction` calls `POST /v1/wallets/{id}/rpc` with `{ method: "eth_signTransaction", params: { transaction: { to, data, value, chain_id, nonce, gas_limit, max_fee_per_gas, max_priority_fee_per_gas, type: 2 } } }` and returns `data.signed_transaction`. Verify field names at docs.privy.io (Wallets API → Ethereum → signTransaction). Broadcasting stays with our viem public client (`sendRawTransaction`), so Monad chain id 10143 needs no Privy-side chain support.
2. `walletClientFor(env)`: when `TREASURY_SIGNER=privy` and `PRIVY_TREASURY_WALLET_ID` + `PRIVY_TREASURY_ADDRESS` are set, build the wallet client from the Privy account instead of `MONAD_PRIVATE_KEY`. Default stays raw key.
3. `scripts/privy-treasury.ts` (one-shot migration, prints every tx hash): create the Privy wallet → from the raw key: send 1 MON and transfer 5,000 tUSD to it → from the Privy wallet: `approve(settlement, max)` (this is the first real test of signing; stop here if it fails) → from the raw key: `setOperator(privyAddress)` → write `treasury`, `treasurySigner: "privy"`, `privyTreasuryWalletId`, `previousTreasury` into `deployments/monad-testnet.json`. Print the `.env` lines to add (`TREASURY_SIGNER=privy`, ids; never print secrets).
4. Policy (if the Policies API is quick; otherwise skip and say so in README): `POST /v1/policies` restricting `eth_sendTransaction`/`eth_signTransaction` to `to == JingleSettlement` and function selectors `settle` + `absorbDispute`; attach the policy id to the wallet. Show the policy id on `/ops`.
5. Wiring check in MONAD mode: the operator-address guard in `buildRuntime` must compare against `deployment.treasury` (now the Privy address).
6. Ops console: "Treasury signer: Privy wallet <id> · policy <id or none>". README: section "Privy: treasury signing with a policy".
7. Rollback if anything breaks before 7:15: from the raw key, `setOperator(0x9c83…86FA)` and unset `TREASURY_SIGNER`. The demo must never depend on B.
8. Commit: `Privy: treasury signing through a server wallet (policy-scoped)`.

## After 7:15 (no more code)

1. `npm run reset` → `npm run dev:monad` → record demo (3 min max): `/checkout` tap → `/` → `/ops` dispute, plus the Privy beat(s). Script in `../SUBMISSION.md`.
2. Record pitch (2 min max): A on camera, problem, why Jingle, why now. Upload both.
3. Render deploy (steps in `../SUBMISSION-FIELDS.md`): public Git URL, `npm install --include=dev`, `npm start`, env vars incl. `MONAD=true`, the key, and the Privy vars. Confirm one payment on the Render URL.
4. Fill the form from `../SUBMISSION-FIELDS.md` (name, one-liner, description, GTM, repo, live URL, videos, judge access, progress update), logo `../jingle-logo.png`, track 02, add the Privy bounty, submit.
5. Final README touches: video link, Render URL, Privy sections, Envio/Aurora roadmap lines. Push again.

## Submission form, required fields (read from the dashboard at 5:55 PM)

Primary track · project logo (PNG/JPG/WEBP, 500-2000 px, ≤2 MB) · name · one-liner (200) · description (8,000) · GTM and user-acquisition strategy (8,000) · GitHub repo (public) · live product URL ("must run on Monad Mainnet or Testnet") · technical demo video (≤3 min, shows the product running and Monad interactions) · pitch video (≤2 min) · optional judge access instructions · optional bounties with their own questions · at least one progress update. Judging: Completeness, Technical, Monad integration, Track fit, Innovation, 20% each. Bounties: adherence to published requirements 40%.

## Operating rules that carry over

Paired session; A decides, Claude builds and flags. State where you went beyond A's words. `MOCK=true npm run dev` and `npm test` green before every commit. Commit after each part with a plain message. Keys never printed. Hard stop 7:15.
