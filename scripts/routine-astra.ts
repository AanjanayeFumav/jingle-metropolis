/**
 * Session 1 step 6 — the acceptance criterion:
 * a real one-time ACH debit routine in Astra's sandbox, tied to a Fumav PaymentIntent id.
 * Run: npm run routine:astra [-- --amount 1999]
 * Source = player's linked account, destination = Fumav business account, T+1, $19.99.
 */
import { usdFromCents } from "../packages/astra/src/client.js";
import { PaymentEngine } from "../packages/orchestrator/src/engine.js";
import { AlwaysT1Risk, MockConsumerRail, MockSettlementRail } from "../packages/orchestrator/src/mock-rails.js";
import { argValue, astraFromEnv, fail, freshAccessToken } from "./_astra.js";
import { readState, writeState } from "./_state.js";

const client = astraFromEnv();

const main = async () => {
  const s = readState();
  const missing = [
    !s.business?.account_id && "business.account_id (npm run link:astra -- --party business)",
    !s.business?.user_id && "business.user_id (npm run oauth:astra -- --party business)",
  ].filter(Boolean);
  if (missing.length) {
    console.error("✗ Missing state:\n  - " + missing.join("\n  - "));
    process.exit(1);
  }
  const amountCents = Number(argValue("--amount") ?? "1999");
  const token = await freshAccessToken(client, "player");

  // Source must have balance capabilities (Plaid-connected). Routing-number accounts are rejected by Astra:
  // "Cannot create ACH Routine: Source account has no balance capabilities."
  const accounts = await client.listAccounts(token);
  const balanceCapable = accounts.filter((a) => a.available_balance !== undefined || a.current_balance !== undefined);
  const sourceId = argValue("--source") ?? balanceCapable[0]?.id ?? s.player?.account_id ?? accounts[0]?.id;
  if (!sourceId) {
    console.error("✗ player has no linked accounts — connect a bank in the OAuth module or run link:astra");
    process.exit(1);
  }
  console.log(`→ player accounts: ${accounts.length} (${balanceCapable.length} balance-capable) — source = ${sourceId}`);
  for (const a of accounts) {
    console.log(`   ${a.id}  ${a.institution_name ?? ""}  mask=${a.mask ?? "?"}  avail=${String(a.available_balance ?? "n/a")}`);
  }
  if (sourceId !== s.player?.account_id) writeState({ player: { account_id: sourceId } });

  // A genuine Fumav PaymentIntent — its id is the ACH correlation key.
  const engine = new PaymentEngine(new MockConsumerRail(), new MockSettlementRail(), new AlwaysT1Risk());
  const intent = engine.createPayment({
    merchantId: "merchant_demo",
    playerId: s.player!.user_id ?? "player_unknown",
    amount: amountCents,
  });
  console.log(`→ PaymentIntent ${intent.id}: amount ${intent.amount}¢, fee ${intent.feeAmount}¢`);

  console.log(`→ POST /v1/routines (one-time ach, T+1, $${usdFromCents(intent.amount)})…`);
  const routine = await client.createRoutine(token, {
    type: "one-time",
    name: `Fumav ${intent.id}`,
    source_id: sourceId,
    destination_id: s.business!.account_id!,
    destination_user_id: s.business!.user_id!,
    amount: usdFromCents(intent.amount),
    payment_type: "ach",
    preferred_settlement_speed: "T+1",
    client_correlation_id: intent.id,
  });
  console.log(`✓ Routine created: ${routine.id} status=${routine.status}`);
  writeState({ last_intent_id: intent.id, last_routine_id: routine.id });

  const fetched = await client.getRoutine(token, routine.id);
  console.log("→ GET routine:", JSON.stringify(fetched, null, 2));

  const transfers = await client.listTransfers(token);
  const mine = transfers.filter((t) => t.routine_id === routine.id);
  console.log(`→ Transfers for this routine: ${mine.length} (of ${transfers.length} total for player)`);
  for (const t of mine) console.log("  ", JSON.stringify(t));
  if (mine[0]) writeState({ last_transfer_id: mine[0].id });

  console.log(`\nAC check: dashboard-sandbox.astra.finance → Routines should show ${routine.id} with correlation ${intent.id}`);
};

main().catch(fail);
