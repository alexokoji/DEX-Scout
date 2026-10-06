/**
 * What a swap of a given token costs in gas on an EVM chain, as the swap aggregators measure it for a real route on that chain at
 * the chain's current gas price. Nothing here is a number we chose: the gas units of a swap depend on the route (measured live
 * for the same small swap: 711,585 on Base by one aggregator and 194,640 by another, 287,581 on BNB Chain, 480,071 on Ethereum),
 * so no single constant is right. Used to size what to keep back for fees before a trade, when no transaction exists yet to
 * estimate. The aggregator's own quote carries the fee of the actual route once there is one.
 */
import { CHAINS, NATIVE_EVM } from "../../chains";
import type { ChainId } from "../../types";
import { getJson } from "../http";

/** a small amount of the native coin to route with (0.01): the size of the probe doesn't change what a swap costs in gas */
const PROBE_NATIVE_WEI = BigInt("10000000000000000");

const cache = new Map<string, { at: number; usd: number | null }>();

/** Gas cost in USD per aggregator, for a route native coin -> token. Each is null when that aggregator has no route or isn't on the chain. */
async function kyberGasUsd(chain: ChainId, token: string): Promise<number | null> {
  const slug = CHAINS[chain].kyberSlug;
  if (!slug) return null;
  const qs = new URLSearchParams({ tokenIn: NATIVE_EVM, tokenOut: token, amountIn: PROBE_NATIVE_WEI.toString() });
  const j = await getJson<{ data?: { routeSummary?: { gasUsd?: string } } }>(`https://aggregator-api.kyberswap.com/${slug}/api/v1/routes?${qs}`, { headers: { "x-client-id": "dexscout" } }, 8_000).catch(() => null);
  const v = Number(j?.data?.routeSummary?.gasUsd);
  return Number.isFinite(v) && v > 0 ? v : null;
}

async function paraswapGasUsd(chain: ChainId, token: string, tokenDecimals: number): Promise<number | null> {
  const meta = CHAINS[chain];
  if (!meta.paraswap || !meta.evmChainId) return null;
  const qs = new URLSearchParams({ srcToken: NATIVE_EVM, destToken: token, amount: PROBE_NATIVE_WEI.toString(), srcDecimals: "18", destDecimals: String(tokenDecimals), side: "SELL", network: String(meta.evmChainId), version: "6.2" });
  const j = await getJson<{ priceRoute?: { gasCostUSD?: string } }>(`https://api.paraswap.io/prices?${qs}`, undefined, 8_000).catch(() => null);
  const v = Number(j?.priceRoute?.gasCostUSD);
  return Number.isFinite(v) && v > 0 ? v : null;
}

/**
 * What a swap into `token` costs in gas right now according to the aggregator the swap would actually go through: the same
 * order the DEX adapter tries them (ParaSwap, then KyberSwap), so the amount kept back matches the quote the trade will show.
 * They disagree a lot on the same swap (measured: $0.17 and $0.76 on Ethereum), so mixing them would hold back the wrong amount.
 * null = no aggregator could say, which callers treat as unknown rather than guessing.
 */
export async function referenceSwapGasUsd(chain: ChainId, token: string, tokenDecimals: number): Promise<number | null> {
  const key = `${chain}:${token.toLowerCase()}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < 60_000) return hit.usd;
  const [k, p] = await Promise.all([kyberGasUsd(chain, token), paraswapGasUsd(chain, token, tokenDecimals)]);
  const usd = p ?? k;
  if (cache.size > 500) cache.clear();
  cache.set(key, { at: Date.now(), usd });
  return usd;
}

/** For tests. */
export function resetSwapGasCache() {
  cache.clear();
}
