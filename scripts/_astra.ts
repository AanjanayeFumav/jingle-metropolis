/** Shared helpers for the Astra live-sandbox scripts. */
import "dotenv/config";
import { AstraApiError, AstraClient } from "../packages/astra/src/client.js";
import { type PartyKey, mask, readState, writeState } from "./_state.js";

export function need(name: string): string {
  const v = process.env[name];
  if (!v) {
    console.error(`✗ Missing ${name} in ./.env`);
    process.exit(1);
  }
  return v;
}

export function argValue(flag: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 && process.argv[i + 1] !== undefined ? process.argv[i + 1] : fallback;
}

export function hasFlag(flag: string): boolean {
  return process.argv.includes(flag);
}

export function partyFromArgs(): PartyKey {
  const p = argValue("--party", "player");
  if (p !== "player" && p !== "business") {
    console.error(`✗ --party must be "player" or "business", got "${p}"`);
    process.exit(1);
  }
  return p;
}

export function astraFromEnv(): AstraClient {
  return new AstraClient({
    clientId: need("ASTRA_CLIENT_ID"),
    clientSecret: need("ASTRA_CLIENT_SECRET"),
    sandbox: (process.env.ASTRA_SANDBOX ?? "true") !== "false",
    oauthHost: process.env.ASTRA_OAUTH_HOST || undefined,
  });
}

export function redirectUri(): string {
  return need("ASTRA_REDIRECT_URI");
}

/** Returns a valid access token for the party, refreshing (and persisting) if it is about to expire. */
export async function freshAccessToken(client: AstraClient, party: PartyKey): Promise<string> {
  const tokens = readState()[party]?.tokens;
  if (!tokens) {
    console.error(`✗ No tokens for ${party}. Run: npm run oauth:astra -- --party ${party}`);
    process.exit(1);
  }
  const msLeft = new Date(tokens.expires_at).getTime() - Date.now();
  if (msLeft > 60_000) return tokens.access_token;

  console.log(`→ ${party} access token expired/expiring — refreshing…`);
  const t = await client.refreshAccessToken(tokens.refresh_token, redirectUri());
  const now = Date.now();
  writeState({
    [party]: {
      tokens: {
        access_token: t.access_token,
        refresh_token: t.refresh_token ?? tokens.refresh_token,
        expires_at: new Date(now + t.expires_in * 1000).toISOString(),
        obtained_at: new Date(now).toISOString(),
      },
    },
  });
  console.log(`✓ refreshed (access ${mask(t.access_token)})`);
  return t.access_token;
}

export function fail(err: unknown): never {
  if (err instanceof AstraApiError) {
    console.error(`✗ Astra ${err.status} (request-id ${err.requestId ?? "n/a"})`);
    console.error(JSON.stringify(err.body, null, 2));
  } else {
    console.error("✗", err);
  }
  process.exit(1);
}
