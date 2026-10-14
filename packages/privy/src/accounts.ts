/**
 * Merchant payout accounts: a Privy-managed wallet per merchant, created server-side from an email.
 * Persisted to .jingle-merchants.json (gitignored) when a path is given; in-memory otherwise (MOCK, tests).
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Address } from "viem";
import type { PrivyClient } from "./client.js";

export interface PayoutAccount {
  email: string;
  privyWalletId: string;
  address: Address;
  createdAt: string;
}

export class PayoutAccounts {
  private readonly accounts = new Map<string, PayoutAccount>();
  private readonly pending = new Map<string, Promise<{ account: PayoutAccount; created: boolean }>>();

  constructor(readonly privy: PrivyClient, private readonly path?: string) {
    if (path && existsSync(path)) {
      for (const [id, a] of Object.entries(JSON.parse(readFileSync(path, "utf8")) as Record<string, PayoutAccount>)) this.accounts.set(id, a);
    }
  }

  get(merchantId: string): PayoutAccount | undefined {
    return this.accounts.get(merchantId);
  }

  /** Idempotent: an existing account is returned as is (created=false), whatever email is passed. */
  async ensure(merchantId: string, email: string, displayName?: string): Promise<{ account: PayoutAccount; created: boolean }> {
    const existing = this.accounts.get(merchantId);
    if (existing) return { account: existing, created: false };
    const inflight = this.pending.get(merchantId);
    if (inflight) return inflight.then((r) => ({ ...r, created: false }));
    const p = (async () => {
      const w = await this.privy.createWallet({ idempotencyKey: `jingle-payout-${merchantId}`, displayName });
      const account: PayoutAccount = { email, privyWalletId: w.id, address: w.address, createdAt: new Date().toISOString() };
      this.accounts.set(merchantId, account);
      this.save();
      return { account, created: true };
    })();
    this.pending.set(merchantId, p);
    try {
      return await p;
    } finally {
      this.pending.delete(merchantId);
    }
  }

  private save(): void {
    if (!this.path) return;
    mkdirSync(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, JSON.stringify(Object.fromEntries(this.accounts), null, 2) + "\n");
    renameSync(tmp, this.path);
  }
}
