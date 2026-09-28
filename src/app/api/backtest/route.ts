import { z } from "zod";
import { computeIndicators } from "@/core/analysis/indicators";
import { CHAIN_IDS } from "@/core/chains";
import { providers } from "@/core/providers/registry";
import { runBacktest, type HistoricalBar, type Strategy } from "@/core/strategy/engine";
import { TIMEFRAMES, type ChainId } from "@/core/types";
import { ApiError, parseBody, protectedRoute, serialize } from "@/lib/api";
import { findToken } from "@/services/queries";
import { getSettings } from "@/services/settings";

const body = z.object({
  chain: z.enum(CHAIN_IDS).default("solana"),
  tokenAddress: z.string().min(32).max(44),
  timeframe: z.enum(TIMEFRAMES as [string, ...string[]]).default("15m"),
  positionUsd: z.number().positive().max(100_000).default(10),
  maxOpenPositions: z.number().int().min(1).max(50).default(3),
  capitalUsd: z.number().positive().max(10_000_000).default(100),
  feeBps: z.number().min(0).max(500).default(60),
});

const toCandles = (history: HistoricalBar[]) => history.map((b) => ({ time: b.time, open: b.price, high: b.price, low: b.price, close: b.price, volume: b.volume, buys: 0, sells: 0 }));

/** Momentum entry: EMA9 crosses above EMA21 on elevated volume with RSI not overheated. */
const momentum: Strategy = {
  name: "EMA cross + volume",
  shouldEnter(history) {
    if (history.length < 30) return false;
    const a = computeIndicators(toCandles(history));
    const prev = computeIndicators(toCandles(history.slice(0, -1)));
    if (a.ema9 === null || a.ema21 === null || prev.ema9 === null || prev.ema21 === null) return false;
    const crossed = prev.ema9 <= prev.ema21 && a.ema9 > a.ema21;
    return crossed && (a.volumeSpike ?? 0) >= 1.2 && (a.rsi14 ?? 50) < 75;
  },
};

export const POST = protectedRoute(
  async ({ req, user }) => {
    const b = await parseBody(req, body);
    const settings = await getSettings(user.id);
    const token = await findToken(b.tokenAddress, b.chain);
    if (!token) throw new ApiError("Token not found", 404);
    const candles = await providers().data.getCandles(token.chain as ChainId, token.address, b.timeframe as (typeof TIMEFRAMES)[number], 500);
    if (candles.length < 40) throw new ApiError("Not enough history for a backtest", 422);
    const bars: HistoricalBar[] = candles.map((c) => ({ time: c.time, price: c.close, volume: c.volume, liquidityUsd: 0 }));
    const result = runBacktest(bars, momentum, { capitalUsd: b.capitalUsd, positionUsd: b.positionUsd, maxOpenPositions: b.maxOpenPositions, targets: settings.targets, feeBps: b.feeBps, markToMarketAtEnd: true });
    return serialize({ strategy: momentum.name, bars: bars.length, targets: settings.targets, ...result });
  },
  { limit: { max: 20, windowMs: 60_000, key: "backtest" } },
);
