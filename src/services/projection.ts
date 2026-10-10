import { defaultHorizon, projectRise, suggestLadder, type Projection } from "@/core/analysis/projection";
import { withTimeout } from "@/core/providers/http";
import { providers } from "@/core/providers/registry";
import type { Candle, ChainId, ProfitTargetConfig } from "@/core/types";

/**
 * A token's projected rises, from its own recent price history (see core/analysis/projection.ts). History comes from the market data
 * provider at 15-minute candles, as far back as it serves (about ten days), which is enough for one-hour and four-hour figures and a
 * rougher one-day figure. One request per token: the answer is kept for a few minutes, because a token's history doesn't change
 * enough in that time to matter, and the provider is rate-limited.
 */
const TIMEFRAME = "15m" as const;
const TIMEFRAME_MIN = 15;
const HISTORY_CANDLES = 1000;
const OK_TTL_MS = 10 * 60_000;
/** an empty answer (not enough history, or the provider was busy) is asked again sooner */
const MISS_TTL_MS = 2 * 60_000;

const cache = new Map<string, { at: number; ttl: number; p: Projection | null }>();

export async function projectionFor(chain: ChainId, address: string): Promise<Projection | null> {
  const key = `${chain}:${address.toLowerCase()}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < hit.ttl) return hit.p;
  let p: Projection | null = null;
  try {
    const candles = await withTimeout(providers().data.getCandles(chain, address, TIMEFRAME, HISTORY_CANDLES), 15_000, "price history");
    p = projectRise(candles, TIMEFRAME_MIN);
  } catch {
    p = null; // no history to read: no projection, said plainly by the caller, never a guessed one
  }
  if (cache.size > 500) cache.clear();
  cache.set(key, { at: Date.now(), ttl: p ? OK_TTL_MS : MISS_TTL_MS, p });
  return p;
}

/**
 * Targets for a new position drawn from that token's own history, keeping the user's sell shares. null when there isn't enough
 * history (or the token has gone nowhere), in which case the caller uses the user's own ladder.
 */
export async function projectedTargets(chain: ChainId, address: string, userLadder: ProfitTargetConfig[]): Promise<ProfitTargetConfig[] | null> {
  const p = await projectionFor(chain, address);
  const h = p ? defaultHorizon(p) : null; // the longest window with real history behind it
  if (!h) return null;
  return suggestLadder(h, userLadder.map((t) => t.sellPct), "typical");
}

/**
 * Targets for a scalp: the shortest window the token's history supports (an hour), at the cautious preset (rises reached in most of the
 * token's own past windows, so they are likely to fill), keeping the user's sell shares. null when there isn't enough history.
 */
export async function scalpTargets(chain: ChainId, address: string, userLadder: ProfitTargetConfig[]): Promise<ProfitTargetConfig[] | null> {
  const p = await projectionFor(chain, address);
  const h = p?.horizons[0]; // horizons are in ascending order: the first is the shortest
  if (!h) return null;
  return suggestLadder(h, userLadder.map((t) => t.sellPct), "cautious");
}

const candleCache = new Map<string, { at: number; candles: Candle[] }>();
/**
 * The token's recent chart for judging an entry: five-minute candles covering the last four hours (the window the dip is judged over:
 * four times the one-hour scalp horizon). Kept for a minute, because the bot looks at several signals each cycle.
 */
export async function recentCandles(chain: ChainId, address: string): Promise<Candle[] | null> {
  const key = `${chain}:${address.toLowerCase()}`;
  const hit = candleCache.get(key);
  if (hit && Date.now() - hit.at < 60_000) return hit.candles;
  try {
    const candles = await withTimeout(providers().data.getCandles(chain, address, "5m", 48), 12_000, "recent chart");
    if (candleCache.size > 200) candleCache.clear();
    candleCache.set(key, { at: Date.now(), candles });
    return candles;
  } catch {
    return null;
  }
}

/** For tests. */
export function resetProjectionCache() {
  cache.clear();
}
