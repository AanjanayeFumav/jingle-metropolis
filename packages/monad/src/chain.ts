/**
 * Monad chain config + explorer helpers. Defaults are Monad testnet; every value can be overridden from .env
 * so the same code points at mainnet (with real USDC) by config, not by edits.
 */
import { defineChain, type Chain } from "viem";

export interface MonadEnv {
  MONAD_RPC_URL?: string;
  MONAD_CHAIN_ID?: string;
  MONAD_EXPLORER_URL?: string;
}

export const MONAD_TESTNET_DEFAULTS = {
  chainId: 10143,
  rpcUrl: "https://testnet-rpc.monad.xyz",
  explorerUrl: "https://testnet.monadexplorer.com",
} as const;

export function monadChain(env: MonadEnv = process.env): Chain {
  const id = Number(env.MONAD_CHAIN_ID ?? MONAD_TESTNET_DEFAULTS.chainId);
  const rpc = env.MONAD_RPC_URL ?? MONAD_TESTNET_DEFAULTS.rpcUrl;
  const explorer = env.MONAD_EXPLORER_URL ?? MONAD_TESTNET_DEFAULTS.explorerUrl;
  return defineChain({
    id,
    name: id === MONAD_TESTNET_DEFAULTS.chainId ? "Monad Testnet" : `Monad (${id})`,
    nativeCurrency: { name: "Monad", symbol: "MON", decimals: 18 },
    rpcUrls: { default: { http: [rpc] } },
    blockExplorers: { default: { name: "Monad Explorer", url: explorer } },
  });
}

export function explorerTxUrl(env: MonadEnv, hash: string): string {
  return `${env.MONAD_EXPLORER_URL ?? MONAD_TESTNET_DEFAULTS.explorerUrl}/tx/${hash}`;
}

export function explorerAddressUrl(env: MonadEnv, address: string): string {
  return `${env.MONAD_EXPLORER_URL ?? MONAD_TESTNET_DEFAULTS.explorerUrl}/address/${address}`;
}
