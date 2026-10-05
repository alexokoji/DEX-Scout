/**
 * KyberSwap limit orders (DSLO) for EVM auto-sell on chains CoW doesn't serve. Keyless. The user approves the sell token
 * to Kyber's order contract once and signs an off-chain EIP-712 order; Kyber's keepers fill it when the price is reached.
 * Proceeds arrive as the chain's WRAPPED native token (WETH, WBNB, ...), since the order's taker asset must be an ERC-20.
 *
 * Verified live while building: sign-message returns the typed data; the order endpoint checks the signature FIRST (a wrong
 * or garbage signature is rejected as invalid, a correct one passes and is only stopped by the empty test wallet), the
 * cancel-sign endpoint, and the real shapes of order listings (statuses open / partially_filled / expired, filled amounts and
 * transaction hashes). The success response of order creation was not observed (no funded wallet), so the new order's id is
 * read defensively and otherwise found by matching it in the maker's listing.
 */
import { encodeFunctionData, erc20Abi, getAddress } from "viem";
import type { ChainId } from "../../types";
import { CHAINS } from "../../chains";
import { evmRpc } from "../evm/evmProviders";

const BASE = "https://limit-order.kyberswap.com";
export const kyberSupports = (chain: ChainId) => !!CHAINS[chain]?.kyberLimitOrders;

async function kyber<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, { ...init, signal: AbortSignal.timeout(20_000) });
  const text = await res.text();
  let body: unknown = text;
  try {
    body = JSON.parse(text);
  } catch {
    /* text */
  }
  const b = body as { code?: number; message?: string; errorEntities?: string[]; data?: unknown };
  if (!res.ok || (typeof b?.code === "number" && b.code !== 0)) throw new Error(b?.message ? `${b.message}${b.errorEntities?.length ? ` (${b.errorEntities.join(", ")})` : ""}` : `Kyber HTTP ${res.status}`);
  return (b?.data ?? body) as T;
}
const post = <T>(path: string, body: unknown) => kyber<T>(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

export interface KyberTypedData {
  types: Record<string, { name: string; type: string }[]>;
  domain: Record<string, unknown>;
  primaryType: string;
  message: Record<string, unknown> & { salt?: string };
}

export interface KyberOrderRequest {
  chainId: string;
  makerAsset: string;
  takerAsset: string;
  maker: string;
  allowedSenders: string[];
  makingAmount: string;
  takingAmount: string;
  expiredAt: number;
}

/** The order's typed data from Kyber (it chooses the salt and builds the order's encoded fields). The wallet signs this exact thing. */
export async function kyberSignMessage(req: KyberOrderRequest): Promise<KyberTypedData> {
  const d = await post<KyberTypedData>("/write/api/v1/orders/sign-message", req);
  return { ...d, domain: { ...d.domain, chainId: Number(d.domain.chainId) } };
}

/** The Kyber contract that pulls the sell token (the user's approval goes to this address). */
export async function kyberContract(chain: ChainId): Promise<string> {
  const d = await kyber<{ latest?: string }>(`/read-ks/api/v1/configs/contract-address?chainId=${CHAINS[chain].evmChainId}`);
  if (!d.latest) throw new Error(`No Kyber limit-order contract for ${CHAINS[chain].name}`);
  return getAddress(d.latest);
}

export async function submitKyberOrder(req: KyberOrderRequest, salt: string, signature: string): Promise<{ id: number | null }> {
  const r = await post<{ id?: number; order?: { id?: number } } | null>("/write/api/v1/orders", { ...req, salt, signature });
  const id = r?.id ?? r?.order?.id;
  return { id: typeof id === "number" ? id : null };
}

export interface KyberOrder {
  id: number;
  status: string; // open | partially_filled | filled | cancelled | expired
  makerAsset: string;
  takerAsset: string;
  makingAmount: string;
  takingAmount: string;
  filledMakingAmount: string;
  filledTakingAmount: string;
  expiredAt: number;
  transactions?: { txHash?: string }[];
}

/** A maker's orders. "active" = open + partially filled; "closed" = filled, cancelled, expired. */
export async function kyberOrders(chain: ChainId, maker: string, status: "active" | "closed"): Promise<KyberOrder[]> {
  const out: KyberOrder[] = [];
  for (let page = 1; page <= 4; page++) {
    const d = await kyber<{ orders?: KyberOrder[]; pagination?: { hasMore?: boolean } }>(`/read-ks/api/v1/orders?chainId=${CHAINS[chain].evmChainId}&maker=${maker.toLowerCase()}&status=${status}&page=${page}&pageSize=50`);
    out.push(...(d.orders ?? []));
    if (!d.pagination?.hasMore) break;
  }
  return out;
}

export async function kyberFindOrder(chain: ChainId, maker: string, ref: { id?: number; req?: KyberOrderRequest }): Promise<KyberOrder | null> {
  for (const status of ["active", "closed"] as const) {
    const list = await kyberOrders(chain, maker, status);
    const hit = list.find((o) =>
      ref.id !== undefined
        ? o.id === ref.id
        : !!ref.req && o.makerAsset.toLowerCase() === ref.req.makerAsset.toLowerCase() && o.takerAsset.toLowerCase() === ref.req.takerAsset.toLowerCase() && o.makingAmount === ref.req.makingAmount && o.takingAmount === ref.req.takingAmount && o.expiredAt === ref.req.expiredAt,
    );
    if (hit) return hit;
  }
  return null;
}

export const kyberFills = (o: KyberOrder) => ({ sellRaw: BigInt(o.filledMakingAmount || "0"), buyRaw: BigInt(o.filledTakingAmount || "0"), txHash: o.transactions?.length ? (o.transactions[o.transactions.length - 1].txHash ?? null) : null });

/**
 * Kyber returns the cancellation's signing domain with chainId as the STRING "8453". Signed that way it was rejected as an
 * invalid signature; with a number it verified (checked live: the request then got as far as "order not found" for a wallet
 * that owns nothing). So the domain's chainId is normalised to a number before it reaches the wallet.
 */
export async function kyberCancelSign(chain: ChainId, maker: string, orderIds: number[]): Promise<KyberTypedData> {
  const d = await post<KyberTypedData>("/write/api/v1/orders/cancel-sign", { chainId: String(CHAINS[chain].evmChainId), maker, orderIds });
  return { ...d, domain: { ...d.domain, chainId: Number(d.domain.chainId) } };
}

export async function cancelKyberOrders(chain: ChainId, maker: string, orderIds: number[], signature: string): Promise<void> {
  await post<unknown>("/write/api/v1/orders/cancel", { chainId: String(CHAINS[chain].evmChainId), maker, orderIds, signature });
}

/** How much of `token` the user has already allowed `spender` to pull. */
export async function erc20Allowance(chain: ChainId, token: string, owner: string, spender: string): Promise<bigint> {
  const data = encodeFunctionData({ abi: erc20Abi, functionName: "allowance", args: [getAddress(owner), getAddress(spender)] });
  const out = await evmRpc<string>(chain, "eth_call", [{ to: token, data }, "latest"]);
  return out && out !== "0x" ? BigInt(out) : BigInt(0);
}

/** The one-time approval transaction (exact amount, never unlimited). */
export function erc20ApprovalTx(token: string, spender: string, amountRaw: bigint) {
  return { to: getAddress(token), data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [getAddress(spender), amountRaw] }), value: "0x0" };
}
