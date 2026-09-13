/**
 * Session 2: Bridge Terms of Service acceptance for our EXISTING customers (fumav + merchant).
 * Run: npm run tos:bridge [-- --party fumav|merchant --no-wait]
 * Prints each customer's hosted ToS URL; a person accepts in a browser; this script polls
 * customer.has_accepted_terms_of_service until both are true (no redirect server needed).
 */
import { argValue, hasFlag } from "./_astra.js";
import { type BridgeParty, bridgeFromEnv, failBridge } from "./_bridge.js";
import { readState } from "./_state.js";

const client = bridgeFromEnv();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const main = async () => {
  const s = readState().bridge ?? {};
  const only = argValue("--party") as BridgeParty | undefined;
  const parties: BridgeParty[] = only ? [only] : ["fumav", "merchant"];
  const pending: { party: BridgeParty; id: string }[] = [];

  for (const party of parties) {
    const id = party === "fumav" ? s.fumav_customer_id : s.merchant_customer_id;
    if (!id) {
      console.log(`${party}: no customer in state — run npm run customers:bridge`);
      continue;
    }
    const c = await client.getCustomer(id);
    if (c.has_accepted_terms_of_service) {
      console.log(`✓ ${party} (${id}) already accepted ToS`);
      continue;
    }
    const { url } = await client.getTosAcceptanceLink(id);
    console.log(`\n→ ${party.toUpperCase()} customer ${id} — accept Bridge's terms here:\n${url}\n`);
    pending.push({ party, id });
  }

  if (!pending.length || hasFlag("--no-wait")) return;
  console.log(`Waiting for ${pending.map((p) => p.party).join(" + ")} to accept (polling every 5s, up to 30 min)…`);
  const deadline = Date.now() + 30 * 60_000;
  while (pending.length && Date.now() < deadline) {
    await sleep(5000);
    for (let i = pending.length - 1; i >= 0; i--) {
      const c = await client.getCustomer(pending[i].id);
      if (c.has_accepted_terms_of_service) {
        console.log(`✓ ${pending[i].party} accepted ToS (status now ${c.status})`);
        pending.splice(i, 1);
      }
    }
  }
  if (pending.length) {
    console.error(`✗ timed out waiting for: ${pending.map((p) => p.party).join(", ")}`);
    process.exit(1);
  }
  console.log("\nNext: npm run setup:bridge");
};

main().catch(failBridge);
