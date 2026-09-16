/**
 * Read-only diagnosis of the Astra leg: user statuses, the last routine, its transfers, the source balance.
 * Run: npm run check:astra [-- --routine <id>]
 */
import { argValue, astraFromEnv, fail, freshAccessToken } from "./_astra.js";
import { readState } from "./_state.js";

const client = astraFromEnv();

const main = async () => {
  const s = readState();
  const routineId = argValue("--routine") ?? s.last_routine_id;
  const player = await freshAccessToken(client, "player");
  const business = await freshAccessToken(client, "business");

  for (const [party, token] of [["player", player], ["business", business]] as const) {
    const u = await client.getUser(token);
    console.log(`${party} user ${u.id}: status=${u.status} kyc_type=${u.kyc_type ?? "?"} rejection_reasons=${JSON.stringify(u.rejection_reasons ?? null)}`);
  }

  if (s.player?.account_id) {
    const a = await client.getAccount(player, s.player.account_id);
    console.log(`player source account ${a.id}: status=${a.status ?? "?"} connection=${a.connection_status ?? "?"} available=${String(a.available_balance ?? "n/a")} current=${String(a.current_balance ?? "n/a")} real_time=${String(a.real_time_enabled ?? "?")}`);
  }

  if (!routineId) {
    console.log("no routine id in state; pass --routine <id>");
    return;
  }
  const r = await client.getRoutine(player, routineId);
  console.log(`routine ${r.id}: status=${r.status} active=${r.active} type=${r.type} payment_type=${r.payment_type} amount=${r.amount} speed=${r.preferred_settlement_speed} start_date=${String(r.start_date)} created=${r.created}`);
  const extra = Object.fromEntries(Object.entries(r).filter(([k]) => !["id","status","active","type","payment_type","amount","preferred_settlement_speed","start_date","created","name","source_id","destination_id","destination_user_id","client_correlation_id"].includes(k)));
  if (Object.keys(extra).length) console.log("  other routine fields:", JSON.stringify(extra));

  const rt = await client.listRoutineTransfers(player, routineId);
  console.log(`GET /v1/routines/${routineId}/transfers → ${rt.length} transfer(s)`);
  for (const t of rt) console.log("  ", JSON.stringify(t));

  for (const [party, token] of [["player", player], ["business", business]] as const) {
    const all = await client.listTransfers(token);
    console.log(`GET /v1/transfers as ${party} → ${all.length} transfer(s)`);
    for (const t of all.slice(0, 5)) console.log("  ", JSON.stringify(t));
  }
};

main().catch(fail);
