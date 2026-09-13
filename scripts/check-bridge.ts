/** Read-only: print every Bridge sandbox object we own. Run: npm run check:bridge */
import { bridgeFromEnv, failBridge } from "./_bridge.js";
import { readState } from "./_state.js";

const client = bridgeFromEnv();

const main = async () => {
  const s = readState().bridge ?? {};
  for (const [label, id] of [["fumav", s.fumav_customer_id], ["merchant", s.merchant_customer_id]] as const) {
    if (!id) { console.log(`${label}: (no customer)`); continue; }
    const c = await client.getCustomer(id);
    console.log(`${label} customer ${id}: status=${c.status} tos=${c.has_accepted_terms_of_service} endorsements=${JSON.stringify((c.endorsements ?? []).map((e) => `${e.name}:${e.status}`))}`);
  }
  if (s.fumav_customer_id) {
    for (const w of await client.listWallets(s.fumav_customer_id)) {
      console.log(`treasury wallet ${w.id} ${w.chain}: ${JSON.stringify(w.balances ?? "(no balances field)")}`);
    }
  }
  if (s.merchant_customer_id) {
    for (const a of await client.listExternalAccounts(s.merchant_customer_id)) {
      console.log(`merchant external account ${a.id}: ${a.bank_name} …${a.account?.last_4} active=${a.active}`);
    }
  }
  if (s.last_transfer_id) {
    const t = await client.getTransfer(s.last_transfer_id);
    console.log(`last transfer ${t.id}: state=${t.state} amount=${t.amount} on_behalf_of=${t.on_behalf_of} ref=${t.client_reference_id}`);
  }
};

main().catch(failBridge);
