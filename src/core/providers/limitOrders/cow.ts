/**
 * CoW Protocol limit orders for EVM auto-sell. Free and keyless. The user signs an order off-chain (gasless EIP-712) and
 * approves the sell token once; CoW solvers fill it on-chain when the limit price is reachable, receiving the chain's
 * native currency straight to the user's wallet. Verified live while building this: the order endpoint accepts our
 * signed format, the cancellation format is accepted, and both settlement contracts exist on every chain listed.
 */
import { encodeFunctionData, erc20Abi, getAddress, keccak256, toBytes } from "viem";
import { CHAINS, NATIVE_EVM } from "../../chains";
import type { ChainId } from "../../types";
import { evmRpc } from "../evm/evmProviders";

export const COW_SETTLEMENT = "0x9008D19f58AAbD9eD0D60971565AA8510560ab41" as const;
export const COW_RELAYER = "0xC92E8bdf79f0507f65a392b0ab4667716BFE0110" as const;
const APP_DATA = "{}";
const APP_DATA_HASH = keccak256(toBytes(APP_DATA));

export const cowSupports = (chain: ChainId) => !!CHAINS[chain]?.cowNetwork;
const api = (chain: ChainId) => `https://api.cow.fi/${CHAINS[chain].cowNetwork}/api/v1`;

export interface CowOrder {
  sellToken: string;
  buyToken: string;
  receiver: string;
  sellAmount: string;
  buyAmount: string;
  validTo: number;
  appData: string; // the hash, as signed
  feeAmount: "0";
  kind: "sell";
  partiallyFillable: false;
  sellTokenBalance: "erc20";
  buyTokenBalance: "erc20";
}

const ORDER_TYPES = [
  { name: "sellToken", type: "address" }, { name: "buyToken", type: "address" }, { name: "receiver", type: "address" }, { name: "sellAmount", type: "uint256" }, { name: "buyAmount", type: "uint256" },
  { name: "validTo", type: "uint32" }, { name: "appData", type: "bytes32" }, { name: "feeAmount", type: "uint256" }, { name: "kind", type: "string" }, { name: "partiallyFillable", type: "bool" },
  { name: "sellTokenBalance", type: "string" }, { name: "buyTokenBalance", type: "string" },
];
const DOMAIN_TYPES = [{ name: "name", type: "string" }, { name: "version", type: "string" }, { name: "chainId", type: "uint256" }, { name: "verifyingContract", type: "address" }];

const domain = (chainId: number) => ({ name: "Gnosis Protocol", version: "v2", chainId, verifyingContract: COW_SETTLEMENT });

/** A sell order for `sellAmountRaw` of `sellToken`, paid in the chain's native currency to `owner`, at least `minBuyRaw`. */
export function buildCowOrder(args: { owner: string; sellToken: string; sellAmountRaw: bigint; minBuyRaw: bigint; validTo: number }): CowOrder {
  return {
    sellToken: getAddress(args.sellToken), buyToken: NATIVE_EVM, receiver: getAddress(args.owner), sellAmount: args.sellAmountRaw.toString(), buyAmount: args.minBuyRaw.toString(),
    validTo: args.validTo, appData: APP_DATA_HASH, feeAmount: "0", kind: "sell", partiallyFillable: false, sellTokenBalance: "erc20", buyTokenBalance: "erc20",
  };
}

/** The exact payload a wallet's `eth_signTypedData_v4` needs (the server builds it; the browser only signs it). */
export function cowTypedData(chainId: number, order: CowOrder) {
  return { domain: domain(chainId), types: { EIP712Domain: DOMAIN_TYPES, Order: ORDER_TYPES }, primaryType: "Order" as const, message: order };
}

export function cowCancelTypedData(chainId: number, orderUids: string[]) {
  return { domain: domain(chainId), types: { EIP712Domain: DOMAIN_TYPES, OrderCancellations: [{ name: "orderUids", type: "bytes[]" }] }, primaryType: "OrderCancellations" as const, message: { orderUids } };
}

async function cowFetch<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(15_000) });
  const text = await res.text();
  let body: unknown = text;
  try {
    body = JSON.parse(text);
  } catch {
    /* leave as text */
  }
  if (!res.ok) {
    const b = body as { errorType?: string; description?: string };
    throw new Error(b?.description ? `${b.errorType ?? "CoW error"}: ${b.description}` : `CoW HTTP ${res.status}`);
  }
  return body as T;
}

/** Submit a signed order. Returns the order uid CoW will track it by. */
export async function submitCowOrder(chain: ChainId, order: CowOrder, owner: string, signature: string): Promise<string> {
  return cowFetch<string>(`${api(chain)}/orders`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ...order, appData: APP_DATA, appDataHash: APP_DATA_HASH, signingScheme: "eip712", signature, from: getAddress(owner) }),
  });
}

export async function cancelCowOrders(chain: ChainId, orderUids: string[], signature: string): Promise<void> {
  await cowFetch<unknown>(`${api(chain)}/orders`, { method: "DELETE", headers: { "content-type": "application/json" }, body: JSON.stringify({ orderUids, signature, signingScheme: "eip712" }) });
}

export interface CowOrderStatus {
  status: "open" | "fulfilled" | "cancelled" | "expired" | "presignaturePending" | string;
  executedSellAmount: string;
  executedBuyAmount: string;
}

export async function getCowOrder(chain: ChainId, uid: string): Promise<CowOrderStatus | null> {
  try {
    return await cowFetch<CowOrderStatus>(`${api(chain)}/orders/${uid}`);
  } catch (e) {
    if (e instanceof Error && /OrderNotFound|HTTP 404/.test(e.message)) return null;
    throw e;
  }
}

export async function getCowTradeHashes(chain: ChainId, uid: string): Promise<string[]> {
  const trades = await cowFetch<{ txHash?: string }[]>(`${api(chain)}/trades?orderUid=${uid}`).catch(() => []);
  return [...new Set(trades.map((t) => t.txHash).filter((h): h is string => !!h))];
}

/** How much of `token` the user has already allowed CoW's vault relayer to pull. */
export async function cowAllowance(chain: ChainId, token: string, owner: string): Promise<bigint> {
  const data = encodeFunctionData({ abi: erc20Abi, functionName: "allowance", args: [getAddress(owner), COW_RELAYER] });
  const out = await evmRpc<string>(chain, "eth_call", [{ to: token, data }, "latest"]);
  return out && out !== "0x" ? BigInt(out) : BigInt(0);
}

/** The one-time approval transaction (exact amount, never unlimited). */
export function cowApprovalTx(token: string, amountRaw: bigint) {
  return { to: getAddress(token), data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [COW_RELAYER, amountRaw] }), value: "0x0" };
}
