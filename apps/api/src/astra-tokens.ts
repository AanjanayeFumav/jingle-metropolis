/**
 * TokenStore: the API's view of the two Astra OAuth sessions (player, business) kept in .fumav-state.json.
 * Refreshes when < 60s of access-token life remains, persists the rotated refresh token, and serializes
 * refreshes per party so a poller and a webhook can never race and clobber each other's refresh token
 * (which would end the 10-day session). Same logic as scripts/_astra.ts#freshAccessToken, but throws
 * instead of exiting the process.
 */
import type { AstraClient } from "../../../packages/astra/src/client.js";
import { type PartyKey, mask, readState, writeState } from "../../../scripts/_state.js";

export class TokenStore {
  private readonly inflight = new Map<PartyKey, Promise<string>>();

  constructor(
    private readonly client: AstraClient,
    private readonly redirectUri: string,
  ) {}

  partyFor(astraUserId: string | undefined): PartyKey | undefined {
    if (!astraUserId) return undefined;
    const s = readState();
    if (s.player?.user_id === astraUserId) return "player";
    if (s.business?.user_id === astraUserId) return "business";
    return undefined;
  }

  /** Which sessions to try for a webhook's user_id: the matching one, else both. */
  partiesToTry(astraUserId?: string): PartyKey[] {
    const p = this.partyFor(astraUserId);
    return p ? [p] : ["player", "business"];
  }

  async token(party: PartyKey): Promise<string> {
    const tokens = readState()[party]?.tokens;
    if (!tokens) throw new Error(`no Astra tokens for ${party}; run: npm run oauth:astra -- --party ${party}`);
    if (new Date(tokens.expires_at).getTime() - Date.now() > 60_000) return tokens.access_token;

    let p = this.inflight.get(party);
    if (!p) {
      p = this.refresh(party, tokens.refresh_token).finally(() => this.inflight.delete(party));
      this.inflight.set(party, p);
    }
    return p;
  }

  private async refresh(party: PartyKey, refreshToken: string): Promise<string> {
    const t = await this.client.refreshAccessToken(refreshToken, this.redirectUri);
    const now = Date.now();
    writeState({
      [party]: {
        tokens: {
          access_token: t.access_token,
          refresh_token: t.refresh_token ?? refreshToken,
          expires_at: new Date(now + t.expires_in * 1000).toISOString(),
          obtained_at: new Date(now).toISOString(),
        },
      },
    });
    console.log(`[astra] refreshed ${party} access token (${mask(t.access_token)})`);
    return t.access_token;
  }
}
