/**
 * Smoke test / Session 1 step 2: create the PLAYER's UserIntent in the Astra sandbox.
 * Run: npm run smoke:astra [-- --email you+tag@x.com]   (reads ./.env)
 * Success: prints a user_intent id (also saved to .fumav-state.json → player.user_intent_id)
 *          visible in dashboard-sandbox.astra.finance → Users.
 * Gotcha: max 3 UserIntents per email — rotate plus-tags with --email.
 */
import { argValue, astraFromEnv, fail, need } from "./_astra.js";
import { writeState } from "./_state.js";

const client = astraFromEnv();
const stamp = Date.now();
const email = argValue("--email") ?? need("SMOKE_EMAIL");
const phone = need("SMOKE_PHONE"); // +1XXXXXXXXXX — sandbox test number for the player

const main = async () => {
  console.log(`→ Creating player UserIntent in Astra sandbox (email ${email})…`);
  const created = await client.createUserIntent({
    email,
    phone,
    first_name: "Fumav",
    last_name: "PlayerOne",
    address1: "123 Astra Ave",
    address2: "",
    city: "Palo Alto",
    state: "CA",
    postal_code: "94304",
    date_of_birth: "1995-02-03", // NOT YYYY-01-01 (sandbox reject trigger)
    ssn: "1234",
    ip_address: process.env.DEV_PUBLIC_IP || "192.0.2.0",
    metadata: { fumav_player_id: `smoke-${stamp}` },
  });

  console.log(`✓ UserIntent created: ${created.id}`);
  writeState({ player: { user_intent_id: created.id } });

  const intent = await client.getUserIntent(created.id);
  console.log("→ Status payload:", JSON.stringify(intent, null, 2));
  console.log("\nCheck dashboard-sandbox.astra.finance → Users. Next: npm run oauth:astra");
};

main().catch(fail);
