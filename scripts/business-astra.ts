/**
 * Session 1 step 5a: create Fumav's Business Profile in the Astra sandbox (the ACH pull destination).
 * Run: npm run business:astra [-- --bc <business_classification> --ic <industry_classification> --force]
 * Sandbox: EIN 11-1111111 auto-approves KYB. Then: npm run oauth:astra -- --party business
 */
import { argValue, astraFromEnv, fail, hasFlag, need } from "./_astra.js";
import { readState, writeState } from "./_state.js";

const client = astraFromEnv();

const main = async () => {
  const existing = readState().business?.business_profile_id;
  if (existing && !hasFlag("--force")) {
    console.log(`✓ business_profile_id already in state: ${existing} (pass --force to create another)`);
    console.log(JSON.stringify(await client.getBusinessProfile(existing), null, 2));
    return;
  }

  const phone = need("BUSINESS_ADMIN_PHONE");
  const adminEmail =
    process.env.BUSINESS_ADMIN_EMAIL ||
    need("SMOKE_EMAIL").replace(/(\+[^@]*)?@/, "+fumavbiz@");
  const address = { address1: "548 Market St", address2: "", city: "San Francisco", state: "CA", postal_code: "94104" };

  console.log(`→ Creating Fumav business profile (admin ${adminEmail})…`);
  const created = await client.createBusinessProfile({
    phone,
    email: adminEmail,
    first_name: "Fumav",
    last_name: "Admin",
    kyb_type: "verified",
    business_info: {
      business_name: "Fumav Inc",
      business_type: "llc",
      ...address,
      business_classification: argValue("--bc") ?? "other",
      industry_classification: argValue("--ic") ?? "other",
      ein: argValue("--ein") ?? "11-1111111", // sandbox auto-approve; pass --ein $FUMAV_EIN for the real one
    },
    business_admin: { first_name: "Fumav", last_name: "Admin", email: adminEmail },
    business_controller: {
      first_name: "Fumav",
      last_name: "Controller",
      email: adminEmail,
      title: "CEO",
      date_of_birth: "1988-06-14", // not YYYY-01-01
      ssn: argValue("--ssn") ?? "1234", // required by the API despite docs; sandbox fake
      ...address,
    },
  });
  console.log(`✓ Business profile created: ${created.id}`);
  writeState({ business: { business_profile_id: created.id } });

  const profile = await client.getBusinessProfile(created.id);
  console.log("→ Profile:", JSON.stringify(profile, null, 2));
  console.log("\nNext: npm run oauth:astra -- --party business   (SMS goes to BUSINESS_ADMIN_PHONE)");
};

main().catch(fail);
