/**
 * Session 1 step 3 (and step 5 for the business): OAuth authorization-code flow.
 * Run: npm run oauth:astra -- --party player|business [--reauth]
 *
 * 1. Prints Astra's hosted OAuth URL → open it, complete SMS OTP.
 * 2. Astra redirects to ASTRA_REDIRECT_URI (local server here) with ?code=&state=.
 *    Sandbox fallback: paste the code (or the full redirect URL) into this terminal.
 * 3. Exchanges the code, stores tokens in .fumav-state.json, fetches GET /v1/user.
 */
import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { createInterface } from "node:readline";
import { argValue, astraFromEnv, fail, hasFlag, partyFromArgs, redirectUri } from "./_astra.js";
import { mask, readState, writeState } from "./_state.js";

const party = partyFromArgs();
const client = astraFromEnv();
const uri = redirectUri();
const me = readState()[party] ?? {};
const nonce = randomBytes(8).toString("hex");

let url: string;
if (party === "player") {
  const intentId = argValue("--intent") ?? me.user_intent_id;
  if (hasFlag("--reauth") && me.user_id) {
    url = client.authorizeUrl({ redirectUri: uri, userId: me.user_id, state: nonce });
  } else {
    if (!intentId) {
      console.error("✗ No player.user_intent_id in state. Run npm run smoke:astra first, or pass --intent <id>.");
      process.exit(1);
    }
    url = client.authorizeUrl({ redirectUri: uri, userIntentId: intentId, state: nonce });
  }
} else {
  const profileId = argValue("--profile") ?? me.business_profile_id;
  if (hasFlag("--reauth") && me.user_id) {
    url = client.authorizeUrl({ redirectUri: uri, userId: me.user_id, state: nonce });
  } else {
    if (!profileId) {
      console.error("✗ No business.business_profile_id in state. Run npm run business:astra first.");
      process.exit(1);
    }
    url = client.authorizeUrl({ redirectUri: uri, businessProfileId: profileId, state: nonce });
  }
}

const cb = new URL(uri);
const port = Number(cb.port || 80);

let done = false;
async function finish(code: string, stateParam: string | null): Promise<void> {
  if (done) return;
  done = true;
  if (stateParam !== null && stateParam !== nonce) {
    console.error(`✗ state mismatch (expected ${nonce}, got ${stateParam}) — refusing to exchange.`);
    process.exit(1);
  }
  try {
    console.log(`→ Exchanging authorization code (${mask(code)})…`);
    const t = await client.exchangeAuthorizationCode(code, uri);
    const now = Date.now();
    writeState({
      [party]: {
        tokens: {
          access_token: t.access_token,
          refresh_token: t.refresh_token,
          expires_at: new Date(now + t.expires_in * 1000).toISOString(),
          obtained_at: new Date(now).toISOString(),
        },
      },
    });
    console.log(`✓ ${party} tokens stored (access ${mask(t.access_token)}, expires in ${t.expires_in}s)`);

    const user = await client.getUser(t.access_token);
    writeState({ [party]: { user_id: user.id, user_status: String(user.status) } });
    console.log(`✓ ${party} user: id=${user.id} status=${user.status} kyc_type=${user.kyc_type ?? "n/a"}`);
    if (user.status !== "approved") {
      console.log("  (not approved yet — rejection_reasons:", JSON.stringify(user.rejection_reasons ?? null), ")");
    }
    console.log(`\nNext: npm run link:astra -- --party ${party}`);
    process.exit(0);
  } catch (err) {
    fail(err);
  }
}

function startServer(): void {
  const server = createServer((req, res) => {
    const u = new URL(req.url ?? "/", `http://localhost:${port}`);
    if (u.pathname !== cb.pathname) {
      res.writeHead(404).end("not the callback path");
      return;
    }
    const err = u.searchParams.get("error");
    if (err) {
      res.writeHead(400, { "Content-Type": "text/html" }).end(`<h2>Astra returned an error: ${err}</h2>`);
      console.error("✗ OAuth error from Astra:", err, u.searchParams.get("error_description") ?? "");
      process.exit(1);
    }
    const code = u.searchParams.get("code");
    if (!code) {
      res.writeHead(400).end("missing code");
      return;
    }
    res
      .writeHead(200, { "Content-Type": "text/html" })
      .end("<h2>Fumav: authorization received. You can close this tab and return to the terminal.</h2>");
    void finish(code, u.searchParams.get("state"));
  });

  server.listen(port, () => {
    console.log(`→ Callback server listening on ${uri}`);
    console.log(`\nOpen this URL in a browser and complete the ${party} login:\n\n${url}\n`);
    console.log("Waiting for the redirect… (or re-run with --code <code|redirect-url> to exchange manually)");
    if (process.stdin.isTTY) {
      const rl = createInterface({ input: process.stdin });
      rl.on("line", (line) => {
        const s = line.trim();
        if (!s) return;
        void finish(codeFrom(s), s.startsWith("http") ? new URL(s).searchParams.get("state") : null);
      });
    }
  });
}

/** Accepts a bare code or the full redirect URL. */
function codeFrom(s: string): string {
  if (!s.startsWith("http")) return s;
  const c = new URL(s).searchParams.get("code");
  if (!c) {
    console.error("✗ no ?code= in that URL");
    process.exit(1);
  }
  return c;
}

const pasted = argValue("--code");
if (pasted) {
  // Manual exchange (sandbox lets you copy the code off Astra's page). State can't be checked here.
  void finish(codeFrom(pasted), null);
} else {
  startServer();
}
