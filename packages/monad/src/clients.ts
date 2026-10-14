/**
 * viem clients for Monad from .env: MONAD_PRIVATE_KEY (treasury / operator signer) + chain config.
 * Artifacts are read from contracts/artifacts (committed) so nothing needs compiling at runtime.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createPublicClient, createWalletClient, http, type Abi, type Address, type Hex, type PublicClient, type WalletClient } from "viem";
import { privateKeyToAccount } from "viem/accounts";
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

export function walletClientFor(env: NodeJS.ProcessEnv = process.env): WalletClient & { account: ReturnType<typeof privateKeyToAccount> } {
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
