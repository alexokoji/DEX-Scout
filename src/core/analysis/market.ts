import type { Candle, MarketAnalysis, Timeframe, TokenSnapshot, TrendDirection } from "../types";
import { computeIndicators } from "./indicators";

const clamp = (n: number, lo = -1, hi = 1) => Math.min(hi, Math.max(lo, n));

interface Swing {
  index: number;
  price: number;
}

function swings(candles: Candle[], span = 2) {
  const highs: Swing[] = [];
  const lows: Swing[] = [];
  for (let i = span; i < candles.length - span; i++) {
    let isHigh = true;
    let isLow = true;
    for (let j = 1; j <= span; j++) {
      if (candles[i].high <= candles[i - j].high || candles[i].high <= candles[i + j].high) isHigh = false;
      if (candles[i].low >= candles[i - j].low || candles[i].low >= candles[i + j].low) isLow = false;
    }
    if (isHigh) highs.push({ index: i, price: candles[i].high });
    if (isLow) lows.push({ index: i, price: candles[i].low });
  }
  return { highs, lows };
}

/** Ratio helper: how much `recent` rate exceeds `baseline` rate, mapped to -1..1. */
function rateMomentum(recentRate: number, baselineRate: number): number {
  if (baselineRate <= 0) return recentRate > 0 ? 1 : 0;
  return clamp((recentRate / baselineRate - 1) / 2);
}

export function analyzeMarket(snap: TokenSnapshot, candles: Candle[], timeframe: Timeframe): MarketAnalysis {
  const ind = computeIndicators(candles);
  const last = candles[candles.length - 1];
  const close = last?.close ?? snap.priceUsd;

  let trend: TrendDirection = "SIDEWAYS";
  if (ind.ema9 !== null && ind.ema21 !== null) {
    if (ind.ema9 > ind.ema21 && close > ind.ema21) trend = "UP";
    else if (ind.ema9 < ind.ema21 && close < ind.ema21) trend = "DOWN";
  } else if (snap.change1h > 3) trend = "UP";
  else if (snap.change1h < -3) trend = "DOWN";

  const priceMomentum = clamp(Math.tanh((0.6 * snap.change1h + 1.2 * snap.change5m) / 20));
  const volumeMomentum = rateMomentum(snap.volume15m / 15, snap.volume1h / 60);
  const liquidityTrend =
    snap.liquidity1hAgoUsd > 0 ? (snap.liquidityUsd / snap.liquidity1hAgoUsd - 1) * 100 : 0;

  const b = snap.buys1h + snap.buys15m;
  const s = snap.sells1h + snap.sells15m;
  const buySellRatio = s === 0 ? (b > 0 ? 3 : 1) : b / s;

  const txMomentum = rateMomentum((snap.buys5m + snap.sells5m) / 5, (snap.buys1h + snap.sells1h) / 60);
  const holderGrowthPct =
    snap.holders > 0 && snap.holders1hAgo > 0 ? (snap.holders / snap.holders1hAgo - 1) * 100 : 0;

  const { highs, lows } = swings(candles.slice(-80));
  const lowsBelow = lows.filter((l) => l.price < close);
  const highsAbove = highs.filter((h) => h.price > close);
  const recent = candles.slice(-30);
  const support = lowsBelow.length
    ? Math.max(...lowsBelow.map((l) => l.price))
    : recent.length
      ? Math.min(...recent.map((c) => c.low))
      : null;
  const resistance = highsAbove.length
    ? Math.min(...highsAbove.map((h) => h.price))
    : recent.length
      ? Math.max(...recent.map((c) => c.high))
      : null;

  const prior = candles.slice(-21, -1);
  const priorHigh = prior.length ? Math.max(...prior.map((c) => c.high)) : Infinity;
  const breakout = !!last && close > priorHigh && (ind.volumeSpike ?? 1) >= 1.3;

  const recentHigh = recent.length ? Math.max(...recent.slice(-10).map((c) => c.high)) : close;
  const drawdown = recentHigh > 0 ? (recentHigh - close) / recentHigh : 0;
  const pullback = trend === "UP" && drawdown >= 0.03 && drawdown <= 0.18 && (ind.ema21 === null || close > ind.ema21 * 0.98);

  const overextended =
    (ind.rsi14 !== null && ind.rsi14 > 80) || (ind.ema21 !== null && close > ind.ema21 * 1.35) || snap.change1h > 120;

  const higherLows = lows.length >= 2 && lows[lows.length - 1].price > lows[lows.length - 2].price;
  let structure = 0;
  if (ind.ema21 !== null && close > ind.ema21) structure += 0.3;
  if (ind.ema9 !== null && ind.ema21 !== null && ind.ema9 > ind.ema21) structure += 0.2;
  if (higherLows) structure += 0.2;
  if (ind.macd && ind.macd.histogram > 0) structure += 0.15;
  if (!overextended) structure += 0.15;
  if (ind.vwap !== null && close > ind.vwap) structure += 0.05;
  if (ind.rsi14 !== null && ind.rsi14 < 30) structure -= 0.1;

  return {
    timeframe,
    trend,
    priceMomentum,
    volumeMomentum,
    liquidityTrend,
    buySellRatio,
    txMomentum,
    holderGrowthPct,
    support,
    resistance,
    breakout,
    pullback,
    indicators: ind,
    structureScore: clamp(structure, 0, 1),
    overextended,
  };
}
