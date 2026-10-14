/**
 * viem clients for Monad from .env: MONAD_PRIVATE_KEY (treasury / operator signer) + chain config.
 * Artifacts are read from contracts/artifacts (committed) so nothing needs compiling at runtime.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createPublicClient, createWalletClient, http, type Abi, type Address, type Hex, type LocalAccount, type PublicClient, type WalletClient } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { RestPrivyClient } from "../../privy/src/client.js";
import { privyAccount } from "../../privy/src/viem-account.js";
import { monadChain, type MonadEnv } from "./chain.js";

export interface Artifact {
  contractName: string;
  abi: Abi;
  bytecode: Hex;
}

export function loadArtifact(name: "JingleSettlement" | "TestUSD", root = process.cwd()): Artifact {
  return JSON.parse(readFileSync(join(root, "contracts", "artifacts", `${name}.json`), "utf8")) as Artifact;
}

export interface Deployment {
  chainId: number;
  rpcUrl: string;
  explorerUrl: string;
  deployedAt: string;
  treasury: Address;
  merchant: Address;
  testUsd: Address;
  settlement: Address;
  txs: Record<string, Hex>;
  /** Set by scripts/privy-treasury.ts when the operator moved to a Privy server wallet. */
  treasurySigner?: "raw" | "privy";
  privyTreasuryWalletId?: string;
  privyPolicyId?: string | null;
  previousTreasury?: Address;
}

export function deploymentPath(root = process.cwd()): string {
  return join(root, "deployments", "monad-testnet.json");
}

export function loadDeployment(root = process.cwd()): Deployment {
  return JSON.parse(readFileSync(deploymentPath(root), "utf8")) as Deployment;
}

export function publicClientFor(env: MonadEnv = process.env): PublicClient {
  const chain = monadChain(env);
  return createPublicClient({ chain, transport: http(chain.rpcUrls.default.http[0]) });
}

export type SigningWalletClient = WalletClient & { account: LocalAccount };

/** The treasury signer: a Privy server wallet when TREASURY_SIGNER=privy, else the raw key (default). */
export function walletClientFor(env: NodeJS.ProcessEnv = process.env): SigningWalletClient {
  if (env.TREASURY_SIGNER === "privy") return privyWalletClientFor(env);
  return rawKeyWalletClientFor(env);
}

export function privyWalletClientFor(env: NodeJS.ProcessEnv = process.env, ids?: { walletId: string; address: Address }): SigningWalletClient {
  const walletId = ids?.walletId ?? env.PRIVY_TREASURY_WALLET_ID;
  const address = ids?.address ?? (env.PRIVY_TREASURY_ADDRESS as Address | undefined);
  if (!walletId || !address || !env.PRIVY_APP_ID || !env.PRIVY_APP_SECRET) {
    throw new Error("TREASURY_SIGNER=privy needs PRIVY_APP_ID, PRIVY_APP_SECRET, PRIVY_TREASURY_WALLET_ID, PRIVY_TREASURY_ADDRESS in .env");
  }
  const chain = monadChain(env);
  const account = privyAccount(new RestPrivyClient({ appId: env.PRIVY_APP_ID, appSecret: env.PRIVY_APP_SECRET }), walletId, address);
  const client = createWalletClient({ account, chain, transport: http(chain.rpcUrls.default.http[0]) });
  return Object.assign(client, { account });
}

export function rawKeyWalletClientFor(env: NodeJS.ProcessEnv = process.env): SigningWalletClient {
  const pk = env.MONAD_PRIVATE_KEY;
  if (!pk || !/^0x[0-9a-fA-F]{64}$/.test(pk)) throw new Error("MONAD_PRIVATE_KEY missing or malformed in .env (0x + 64 hex)");
  const chain = monadChain(env);
  const account = privateKeyToAccount(pk as Hex);
  const client = createWalletClient({ account, chain, transport: http(chain.rpcUrls.default.http[0]) });
  return Object.assign(client, { account });
}

/** Integer cents -> 6-decimal token units (USDC / TestUSD). */
export const centsToUnits = (cents: number): bigint => BigInt(cents) * 10_000n;
/** 6-decimal token units -> integer cents (floor). */
export const unitsToCents = (units: bigint): number => Number(units / 10_000n);
