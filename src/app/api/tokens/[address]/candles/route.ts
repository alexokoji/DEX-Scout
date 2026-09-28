import { z } from "zod";
import { emaSeries, computeIndicators, vwap } from "@/core/analysis/indicators";
import { analyzeMarket } from "@/core/analysis/market";
import { providers } from "@/core/providers/registry";
import { TIMEFRAMES, type ChainId } from "@/core/types";
import { ApiError, protectedRoute } from "@/lib/api";
import { collections } from "@/lib/db";
import { findToken } from "@/services/queries";

const q = z.object({
  tf: z.enum(TIMEFRAMES as [string, ...string[]]).default("5m"),
  limit: z.coerce.number().int().min(20).max(1000).default(300),
  chain: z.string().optional(),
});

/** Candles, overlay indicator series, latest indicator values and holder/liquidity history for the chart panel. */
export const GET = protectedRoute<{ address: string }>(async ({ req, params }) => {
  const { tf, limit, chain } = q.parse(Object.fromEntries(new URL(req.url).searchParams));
  const timeframe = tf as (typeof TIMEFRAMES)[number];
  const token = await findToken(params.address, chain);
  if (!token) throw new ApiError("Token not found", 404);
  const c = token.chain as ChainId;
  const p = providers();
  const [candles, snap] = await Promise.all([p.data.getCandles(c, token.address, timeframe, limit), p.data.getSnapshot(c, token.address)]);
  if (!snap) throw new ApiError("Token not found", 404);

  const closes = candles.map((k) => k.close);
  const align = (series: number[]) => {
    const off = candles.length - series.length;
    return series.map((v, i) => ({ time: candles[i + off].time, value: v }));
  };
  // rolling VWAP (anchored to the visible window)
  const vw: { time: number; value: number }[] = [];
  for (let i = 1; i <= candles.length; i++) {
    const v = vwap(candles.slice(0, i));
    if (v !== null) vw.push({ time: candles[i - 1].time, value: v });
  }

  const tokenMetrics = await collections.tokenMetrics();
  const history = await tokenMetrics
    .find({ tokenId: token.id }, { projection: { ts: 1, holders: 1, liquidityUsd: 1 } })
    .sort({ ts: -1 })
    .limit(240)
    .toArray();
  history.reverse();

  return {
    timeframe,
    chain: c,
    candles,
    overlays: { ema9: align(emaSeries(closes, 9)), ema21: align(emaSeries(closes, 21)), vwap: vw },
    indicators: computeIndicators(candles),
    market: analyzeMarket(snap, candles, timeframe),
    history: history.map((h) => ({ time: Math.floor(h.ts.getTime() / 1000), holders: h.holders, liquidityUsd: h.liquidityUsd })),
    source: p.mock ? "MOCK" : "LIVE",
  };
});
