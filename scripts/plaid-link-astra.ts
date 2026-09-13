/**
 * Session 1 step 4 (Plaid path): give the PLAYER a balance-capable bank account.
 * Astra rejects ACH routines whose source was linked by routing number
 * ("Source account has no balance capabilities"), and this sandbox client has no hosted connect screen.
 * So: Plaid SANDBOX item → processor_token (processor "astra") → POST /v1/accounts/processor_token.
 *
 * Run: npm run plaid:astra [-- --institution ins_109508 --party player]
 * Needs PLAID_CLIENT_ID + PLAID_SECRET (Plaid *sandbox* secret) in ./.env.
 */
import { AstraApiError } from "../packages/astra/src/client.js";
import { argValue, astraFromEnv, fail, freshAccessToken, need, partyFromArgs } from "./_astra.js";
import { mask, writeState } from "./_state.js";

const PLAID_BASE = "https://sandbox.plaid.com";
const plaidClientId = need("PLAID_CLIENT_ID");
const plaidSecret = need("PLAID_SECRET");

async function plaid<T>(path: string, body: Record<string, unknown>): Promise<T> {
  const res = await fetch(`${PLAID_BASE}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ client_id: plaidClientId, secret: plaidSecret, ...body }),
  });
  const json = (await res.json()) as Record<string, unknown>;
  if (!res.ok) {
    console.error(`✗ Plaid ${path} → ${res.status}`);
    console.error(JSON.stringify(json, null, 2));
    process.exit(1);
  }
  return json as T;
}

interface PlaidAccount {
  account_id: string;
  name: string;
  mask: string | null;
  type: string;
  subtype: string | null;
  balances: { available: number | null; current: number | null };
}

const party = partyFromArgs();
const client = astraFromEnv();

const main = async () => {
  const institution = argValue("--institution") ?? "ins_109508"; // First Platypus Bank (Plaid sandbox)
  const astraToken = await freshAccessToken(client, party);

  console.log(`→ Plaid sandbox: creating test Item at ${institution} (user_good / pass_good)…`);
  const { public_token } = await plaid<{ public_token: string }>("/sandbox/public_token/create", {
    institution_id: institution,
    initial_products: ["auth"],
    options: { override_username: "user_good", override_password: "pass_good" },
  });

  const { access_token, item_id } = await plaid<{ access_token: string; item_id: string }>(
    "/item/public_token/exchange",
    { public_token },
  );
  console.log(`✓ Plaid item ${item_id} (access ${mask(access_token)})`);

  const { accounts } = await plaid<{ accounts: PlaidAccount[] }>("/accounts/get", { access_token });
  const pick =
    accounts.find((a) => a.type === "depository" && a.subtype === "checking") ??
    accounts.find((a) => a.type === "depository") ??
    accounts[0];
  if (!pick) fail(new Error("Plaid item has no accounts"));
  console.log(
    `→ Plaid account: ${pick.name} (${pick.subtype ?? pick.type}, mask ${pick.mask ?? "?"}, available ${pick.balances.available ?? "n/a"})`,
  );

  const { processor_token } = await plaid<{ processor_token: string }>("/processor/token/create", {
    access_token,
    account_id: pick.account_id,
    processor: "astra",
  });
  console.log(`✓ processor_token for astra (${mask(processor_token)})`);

  console.log(`→ Astra: POST /v1/accounts/processor_token for ${party}…`);
  let created;
  try {
    created = await client.createAccountByProcessorToken(astraToken, { processor_token, institution_id: institution });
  } catch (err) {
    if (err instanceof AstraApiError && err.status === 404) {
      console.log("  404 on the regular host — retrying on the secure host…");
      created = await client.createAccountByProcessorToken(astraToken, { processor_token, institution_id: institution }, { secure: true });
    } else {
      throw err;
    }
  }
  console.log(`✓ Astra account created: ${created.id}`);
  writeState({ [party]: { account_id: created.id } });

  const astraAccounts = await client.listAccounts(astraToken);
  console.log(`→ ${party} now has ${astraAccounts.length} Astra account(s):`);
  for (const a of astraAccounts) {
    console.log(
      `   ${a.id}  ${a.institution_name ?? ""}  mask=${a.mask ?? "?"}  status=${a.connection_status ?? "?"}  available=${String(a.available_balance ?? "n/a")}`,
    );
  }
  console.log(`\nNext: npm run routine:astra`);
};

main().catch(fail);
