/**
 * Session 2 step 1: two business customers in Bridge's sandbox, KYB-approved via the sandbox endpoint.
 *   fumav    — Fumav Inc, owns the treasury wallet
 *   merchant — a demo gaming merchant that receives payouts (on_behalf_of target)
 * Run: npm run customers:bridge [-- --party fumav|merchant --force]   (default: both, skips ones already in state)
 */
import { BridgeApiError, type BusinessCustomerInput } from "../packages/bridge/src/client.js";
import { argValue, hasFlag, need } from "./_astra.js";
import { FUMAV_ADDRESS, MERCHANT_ADDRESS, bridgeFromEnv, failBridge, type BridgeParty } from "./_bridge.js";
import { readState, writeState } from "./_state.js";

const client = bridgeFromEnv();

function inputFor(party: BridgeParty, signedAgreementId?: string): BusinessCustomerInput {
  const base = readState();
  const adminEmail = need("SMOKE_EMAIL").replace(/(\+[^@]*)?@/, party === "fumav" ? "+fumavbridge@" : "+merchantdemo@");
  const person = {
    first_name: party === "fumav" ? "Fumav" : "Sarena",
    last_name: party === "fumav" ? "Admin" : "Owner",
    email: adminEmail,
    birth_date: "1988-06-14",
    residential_address: party === "fumav" ? FUMAV_ADDRESS : MERCHANT_ADDRESS,
    has_ownership: true,
    has_control: true,
    is_signer: true,
    title: "CEO",
    ownership_percentage: 100,
    identifying_information: [{ type: "ssn", issuing_country: "USA", number: "123456789" }],
  };
  if (party === "fumav") {
    return {
      type: "business",
      business_legal_name: "Fumav Inc",
      business_trade_name: "Fumav",
      business_description: "Pay-by-bank payment rail for real-money gaming merchants",
      business_type: "llc",
      email: adminEmail,
      phone: process.env.BUSINESS_ADMIN_PHONE,
      primary_website: "https://fumav.com",
      registered_address: FUMAV_ADDRESS,
      physical_address: FUMAV_ADDRESS,
      business_industry: ["522320"],
      is_dao: false,
      incorporation_date: "2025-01-15",
      estimated_annual_revenue_usd: "0_99999",
      account_purpose: "treasury_management",
      source_of_funds: "owners_capital",
      high_risk_activities: ["none_of_the_above"],
      conducts_money_services: false,
      identifying_information: [{ type: "ein", issuing_country: "USA", number: argValue("--ein") ?? process.env.FUMAV_EIN ?? "11-1111111" }],
      associated_persons: [person],
      client_reference_id: "fumav_treasury",
      ...(signedAgreementId ? { signed_agreement_id: signedAgreementId } : {}),
      ...(base.bridge?.fumav_customer_id ? {} : {}),
    };
  }
  return {
    type: "business",
    business_legal_name: "Sarena Games LLC",
    business_trade_name: "Sarena Games",
    business_description: "Online skill-gaming platform (demo merchant)",
    business_type: "llc",
    email: adminEmail,
    phone: "+15125550142",
    primary_website: "https://sarena.example.com",
    registered_address: MERCHANT_ADDRESS,
    physical_address: MERCHANT_ADDRESS,
    business_industry: ["513210"],
    is_dao: false,
    incorporation_date: "2021-03-02",
    estimated_annual_revenue_usd: "1000000_9999999",
    account_purpose: "receive_payments_for_goods_and_services",
    source_of_funds: "sales_of_goods_and_services",
    high_risk_activities: ["none_of_the_above"],
    conducts_money_services: false,
    identifying_information: [{ type: "ein", issuing_country: "USA", number: "12-3456789" }],
    associated_persons: [person],
    client_reference_id: "merch_sarena",
    ...(signedAgreementId ? { signed_agreement_id: signedAgreementId } : {}),
  };
}

async function ensure(party: BridgeParty): Promise<string> {
  const s = readState().bridge ?? {};
  const key = party === "fumav" ? "fumav_customer_id" : "merchant_customer_id";
  const existing = s[key];
  if (existing && !hasFlag("--force")) {
    const c = await client.getCustomer(existing);
    console.log(`✓ ${party} customer already in state: ${existing} (status ${c.status})`);
    return existing;
  }
  const sig = party === "fumav" ? s.fumav_signed_agreement_id : s.merchant_signed_agreement_id;
  console.log(`→ Creating ${party} business customer${sig ? " (with signed_agreement_id)" : " (no ToS id — will see if Bridge requires it)"}…`);
  const created = await client.createCustomer(inputFor(party, sig));
  console.log(`✓ ${party} customer created: ${created.id} status=${created.status} tos_accepted=${created.has_accepted_terms_of_service}`);
  writeState({ bridge: { [key]: created.id } });

  console.log(`→ POST /customers/${created.id}/simulate_kyc_approval (sandbox)…`);
  try {
    const sim = await client.simulateKycApproval(created.id);
    console.log(`✓ ${JSON.stringify(sim)}`);
  } catch (err) {
    console.log(`⚠ simulate_kyc_approval refused: ${err instanceof BridgeApiError ? `${err.status} ${JSON.stringify(err.body)}` : String(err)} — continuing; approve in the Bridge dashboard or ask Bridge to enable simulation on this key.`);
  }
  const after = await client.getCustomer(created.id);
  console.log(`✓ ${party} customer now: status=${after.status} endorsements=${JSON.stringify((after.endorsements ?? []).map((e) => `${e.name}:${e.status}`))}`);
  return created.id;
}

/** Clears the `control_person_ownership_attestation` requirement: the control person attests via API. */
async function attestOwnership(party: BridgeParty, customerId: string): Promise<void> {
  const persons = await client.listAssociatedPersons(customerId);
  for (const p of persons) {
    if (p.attested_ownership_structure_at) continue;
    const { id, created_at, updated_at, ...fields } = p as Record<string, unknown> & { id: string };
    try {
      await client.updateAssociatedPerson(customerId, id, { ...fields, attested_ownership_structure_at: new Date().toISOString() });
      console.log(`✓ ${party}: associated person ${id} attested ownership structure`);
    } catch (err) {
      console.log(`⚠ ${party}: attestation PUT failed: ${err instanceof BridgeApiError ? `${err.status} ${JSON.stringify(err.body)}` : String(err)}`);
    }
  }
}

const main = async () => {
  const only = argValue("--party") as BridgeParty | undefined;
  const parties: BridgeParty[] = only ? [only] : ["fumav", "merchant"];
  for (const p of parties) {
    const id = await ensure(p);
    await attestOwnership(p, id);
  }
  console.log("\nNext: npm run tos:bridge (accept terms), then npm run setup:bridge");
};

main().catch(failBridge);
