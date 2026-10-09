/**
 * Signing for the bot wallet on EVM chains: builds a transaction from a call (to, data, value), prices it from the chain, signs it with
 * the wallet's key and gives back the raw transaction and its hash (known before it is sent, so it can be recorded first).
 * Every figure comes from the node: the nonce, the gas price, and the gas estimate for this very call.
 */
import { keccak256, type Hex, type PrivateKeyAccount } from "viem";
import { CHAINS } from "../../chains";
import type { ChainId } from "../../types";
import { evmGasPriceWei, evmRpc } from "./evmProviders";

export interface EvmCall {
  to: string;
  data: string;
  value?: string;
}

export interface SignedEvm {
  raw: Hex;
  hash: Hex;
  nonce: number;
  /** what this transaction can cost at most (gas limit x gas price), in wei: the wallet must hold this plus the value */
  maxFeeWei: bigint;
}

/**
 * Extra gas on top of the node's estimate: the estimate is for the state a moment ago, and a swap can use a little more by the time it
 * lands. Unused gas is refunded, so it costs nothing unless needed; a transaction that runs out of gas fails and still pays for it.
 */
const GAS_HEADROOM_NUM = BigInt(6);
const GAS_HEADROOM_DEN = BigInt(5);

export async function signEvmCall(chain: ChainId, account: PrivateKeyAccount, call: EvmCall, opts: { gasFloor?: bigint } = {}): Promise<SignedEvm> {
  const chainId = CHAINS[chain].evmChainId;
  if (!chainId) throw new Error(`${chain} is not an EVM chain`);
  const value = BigInt(call.value || "0x0");
  const [nonceHex, gasPrice, estimate] = await Promise.all([
    evmRpc<string>(chain, "eth_getTransactionCount", [account.address, "pending"], 8_000),
    evmGasPriceWei(chain),
    evmRpc<string>(chain, "eth_estimateGas", [{ from: account.address, to: call.to, data: call.data, value: "0x" + value.toString(16) }], 10_000),
  ]);
  if (gasPrice === null) throw new Error("The chain's gas price could not be read, so nothing was signed");
  let gas = (BigInt(estimate) * GAS_HEADROOM_NUM) / GAS_HEADROOM_DEN;
  if (opts.gasFloor !== undefined && opts.gasFloor > gas) gas = opts.gasFloor;
  const nonce = Number(BigInt(nonceHex));
  const raw = await account.signTransaction({ type: "legacy", chainId, to: call.to as Hex, data: call.data as Hex, value, nonce, gas, gasPrice });
  return { raw, hash: keccak256(raw), nonce, maxFeeWei: gas * gasPrice };
}

/** Broadcast a signed transaction; returns the node's hash. */
export async function sendEvmRaw(chain: ChainId, raw: Hex): Promise<string> {
  return evmRpc<string>(chain, "eth_sendRawTransaction", [raw], 12_000);
}

/** Wait (up to `budgetMs`) for a transaction to be mined: true = succeeded, false = reverted, null = not mined in time. */
export async function waitForEvmReceipt(chain: ChainId, hash: string, budgetMs: number): Promise<boolean | null> {
  const end = Date.now() + budgetMs;
  while (Date.now() < end) {
    const r = await evmRpc<{ status: string } | null>(chain, "eth_getTransactionReceipt", [hash], 5_000).catch(() => null);
    if (r) return r.status === "0x1";
    await new Promise((res) => setTimeout(res, 1_500));
  }
  return null;
}
