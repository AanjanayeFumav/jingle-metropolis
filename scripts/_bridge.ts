/** Shared helpers for the Bridge live-sandbox scripts. */
import "dotenv/config";
import { BridgeApiError, BridgeClient } from "../packages/bridge/src/client.js";
import { need } from "./_astra.js";

export type BridgeParty = "fumav" | "merchant";

export function bridgeFromEnv(): BridgeClient {
  const apiKey = need("BRIDGE_API_KEY");
  const sandbox = (process.env.BRIDGE_SANDBOX ?? "true") !== "false";
  if (sandbox && !apiKey.startsWith("sk-test")) {
    console.error("✗ BRIDGE_API_KEY is not an sk-test key but BRIDGE_SANDBOX is not false — refusing.");
    process.exit(1);
  }
  return new BridgeClient({ apiKey, sandbox });
}

export function bridgePartyFromArgs(): BridgeParty {
  const i = process.argv.indexOf("--party");
  const p = i >= 0 ? process.argv[i + 1] : "merchant";
  if (p !== "fumav" && p !== "merchant") {
    console.error(`✗ --party must be "fumav" or "merchant", got "${p}"`);
    process.exit(1);
  }
  return p;
}

export function failBridge(err: unknown): never {
  if (err instanceof BridgeApiError) {
    console.error(`✗ Bridge ${err.status} (request-id ${err.requestId ?? "n/a"})`);
    console.error(JSON.stringify(err.body, null, 2));
  } else {
    console.error("✗", err);
  }
  process.exit(1);
}

/** Demo identities. Placeholder people on purpose — no founder PII in a sandbox. */
export const FUMAV_ADDRESS = { street_line_1: "548 Market St", city: "San Francisco", subdivision: "CA", postal_code: "94104", country: "USA" };
export const MERCHANT_ADDRESS = { street_line_1: "1200 Game Way", city: "Austin", subdivision: "TX", postal_code: "78701", country: "USA" };
