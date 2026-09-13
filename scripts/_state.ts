/**
 * Local session state for the live-sandbox scripts (Session 1+).
 * File: ./.fumav-state.json — gitignored; holds OAuth tokens, so never commit or paste it.
 * This is scaffolding for the paired sessions, not the product's persistence layer.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

export type PartyKey = "player" | "business";

export interface TokenSet {
  access_token: string;
  refresh_token: string;
  /** ISO timestamp when access_token expires. */
  expires_at: string;
  obtained_at: string;
}

export interface Party {
  user_intent_id?: string;
  business_profile_id?: string;
  user_id?: string;
  user_status?: string;
  tokens?: TokenSet;
  account_id?: string;
}

export interface FumavState {
  player?: Party;
  business?: Party;
  last_intent_id?: string;
  last_routine_id?: string;
  last_transfer_id?: string;
}

export const STATE_FILE = resolve(process.cwd(), ".fumav-state.json");

export function readState(): FumavState {
  if (!existsSync(STATE_FILE)) return {};
  return JSON.parse(readFileSync(STATE_FILE, "utf8")) as FumavState;
}

/** Shallow-merge top level, and merge one level deeper for `player` / `business`. */
export function writeState(patch: Partial<FumavState>): FumavState {
  const cur = readState();
  const next: FumavState = { ...cur, ...patch };
  for (const k of ["player", "business"] as const) {
    if (patch[k]) next[k] = { ...(cur[k] ?? {}), ...patch[k] };
  }
  writeFileSync(STATE_FILE, JSON.stringify(next, null, 2) + "\n", { mode: 0o600 });
  return next;
}

/** Print-safe form of a secret. */
export function mask(s: string | undefined): string {
  if (!s) return "(none)";
  return s.length <= 8 ? "****" : `…${s.slice(-4)}`;
}
