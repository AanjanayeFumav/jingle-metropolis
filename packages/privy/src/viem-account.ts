/**
 * A viem account whose key lives in a Privy server wallet. viem fills nonce/gas/fees as usual, Privy signs
 * (eth_signTransaction), and our own public client broadcasts the raw tx, so Monad (10143) needs no Privy-side
 * chain support. Field names verified at docs.privy.io (Wallets API -> Ethereum -> eth_signTransaction).
 */
import { toHex, type Address, type Hex, type LocalAccount, type TransactionSerializable } from "viem";
import { toAccount } from "viem/accounts";
import type { RestPrivyClient } from "./client.js";

/** viem transaction -> Privy params.transaction. Quantities as hex strings, chain id / nonce / type as numbers. */
export function toPrivyTransaction(tx: TransactionSerializable, from: Address): Record<string, unknown> {
  if (tx.chainId === undefined) throw new Error("transaction has no chainId");
  const q = (v: bigint | number | undefined) => (v === undefined ? undefined : toHex(v));
  const out: Record<string, unknown> = {
    from,
    to: tx.to ?? undefined,
    data: tx.data ?? "0x",
    value: q(tx.value ?? 0n),
    chain_id: tx.chainId,
    nonce: tx.nonce,
    gas_limit: q(tx.gas),
  };
  if (tx.maxFeePerGas !== undefined) {
    Object.assign(out, { type: 2, max_fee_per_gas: q(tx.maxFeePerGas), max_priority_fee_per_gas: q(tx.maxPriorityFeePerGas ?? 0n) });
  } else {
    Object.assign(out, { type: 0, gas_price: q(tx.gasPrice) });
  }
  for (const k of Object.keys(out)) if (out[k] === undefined) delete out[k];
  return out;
}

export function privyAccount(client: Pick<RestPrivyClient, "rpc">, walletId: string, address: Address): LocalAccount {
  return toAccount({
    address,
    async signTransaction(tx) {
      const r = await client.rpc<{ data: { signed_transaction: Hex } }>(walletId, {
        method: "eth_signTransaction",
        params: { transaction: toPrivyTransaction(tx as TransactionSerializable, address) },
      });
      if (!r?.data?.signed_transaction) throw new Error(`Privy eth_signTransaction returned no signed_transaction for wallet ${walletId}`);
      return r.data.signed_transaction;
    },
    async signMessage() {
      throw new Error("Privy treasury account signs transactions only");
    },
    async signTypedData() {
      throw new Error("Privy treasury account signs transactions only");
    },
  });
}
