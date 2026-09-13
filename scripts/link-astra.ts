/**
 * Session 1 step 4/5: link a bank account by account + routing (sandbox: routing 222222226).
 * Run: npm run link:astra -- --party player|business [--account 1000000001]
 * Saves the account id to .fumav-state.json → <party>.account_id, then lists accounts.
 */
import { AstraApiError } from "../packages/astra/src/client.js";
import { argValue, astraFromEnv, fail, freshAccessToken, need, partyFromArgs } from "./_astra.js";
import { writeState } from "./_state.js";

const party = partyFromArgs();
const client = astraFromEnv();
const SANDBOX_ROUTING = "222222226";

const main = async () => {
  const token = await freshAccessToken(client, party);
  const institution = need("ASTRA_INSTITUTION_ID");
  const accountNumber = argValue("--account") ?? (party === "player" ? "1000000001" : "2000000002");

  console.log(`→ Linking ${party} bank account (routing ${SANDBOX_ROUTING}, acct …${accountNumber.slice(-4)})…`);
  let accountId: string | undefined;
  try {
    const created = await client.createAccountByRouting(token, {
      institution_id: institution,
      name: `Fumav ${party} test checking`,
      bank_account_type: "checking",
      account_number: accountNumber,
      routing_number: SANDBOX_ROUTING,
    });
    accountId = created.id;
    console.log(`✓ Account created: ${created.id} (mask ${created.mask ?? "?"}, status ${created.connection_status ?? "?"})`);
  } catch (err) {
    if (err instanceof AstraApiError && err.status === 400) {
      console.log("  400 from Astra (possibly duplicate) — checking existing accounts:", JSON.stringify(err.body));
    } else {
      throw err;
    }
  }

  const accounts = await client.listAccounts(token);
  console.log(`→ ${party} has ${accounts.length} account(s):`);
  for (const a of accounts) {
    console.log(`   ${a.id}  ${a.name ?? a.official_name ?? ""}  mask=${a.mask ?? "?"}  status=${a.connection_status ?? "?"}`);
  }
  if (!accountId) {
    const match = accounts.find((a) => a.mask && accountNumber.endsWith(a.mask)) ?? accounts[0];
    if (!match) fail(new Error("no account created and none listed"));
    accountId = match.id;
    console.log(`  using existing account ${accountId}`);
  }
  writeState({ [party]: { account_id: accountId } });
  console.log(`✓ saved ${party}.account_id = ${accountId}`);
};

main().catch(fail);
