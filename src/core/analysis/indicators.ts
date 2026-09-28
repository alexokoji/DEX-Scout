import type { Candle, IndicatorSet } from "../types";

export function sma(values: number[], period: number): number | null {
  if (values.length < period) return null;
  let s = 0;
  for (let i = values.length - period; i < values.length; i++) s += values[i];
  return s / period;
}

/** Full EMA series, seeded with the SMA of the first `period` values. Returns [] if not enough data. */
export function emaSeries(values: number[], period: number): number[] {
  if (values.length < period) return [];
  const k = 2 / (period + 1);
  const out: number[] = [];
  let prev = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
  out.push(prev);
  for (let i = period; i < values.length; i++) {
    prev = values[i] * k + prev * (1 - k);
    out.push(prev);
  }
  return out;
}

export function ema(values: number[], period: number): number | null {
  const s = emaSeries(values, period);
  return s.length ? s[s.length - 1] : null;
}

/** Wilder's RSI. */
export function rsi(values: number[], period = 14): number | null {
  if (values.length <= period) return null;
  let gain = 0;
  let loss = 0;
  for (let i = 1; i <= period; i++) {
    const d = values[i] - values[i - 1];
    if (d >= 0) gain += d;
    else loss -= d;
  }
  let avgGain = gain / period;
  let avgLoss = loss / period;
  for (let i = period + 1; i < values.length; i++) {
    const d = values[i] - values[i - 1];
    avgGain = (avgGain * (period - 1) + Math.max(0, d)) / period;
    avgLoss = (avgLoss * (period - 1) + Math.max(0, -d)) / period;
  }
  if (avgLoss === 0) return avgGain === 0 ? 50 : 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

export function macd(values: number[], fast = 12, slow = 26, signalP = 9) {
  const f = emaSeries(values, fast);
  const s = emaSeries(values, slow);
  if (!s.length) return null;
  // align: f is longer than s by (slow - fast)
  const offset = f.length - s.length;
  const line = s.map((v, i) => f[i + offset] - v);
  const sig = emaSeries(line, signalP);
  if (!sig.length) return null;
  const m = line[line.length - 1];
  const sg = sig[sig.length - 1];
  return { macd: m, signal: sg, histogram: m - sg };
}

export function vwap(candles: Candle[]): number | null {
  let pv = 0;
  let v = 0;
  for (const c of candles) {
    const typical = (c.high + c.low + c.close) / 3;
    pv += typical * c.volume;
    v += c.volume;
  }
  return v > 0 ? pv / v : null;
}

export function atr(candles: Candle[], period = 14): number | null {
  if (candles.length <= period) return null;
  const trs: number[] = [];
  for (let i = 1; i < candles.length; i++) {
    const c = candles[i];
    const pc = candles[i - 1].close;
    trs.push(Math.max(c.high - c.low, Math.abs(c.high - pc), Math.abs(c.low - pc)));
  }
  let a = trs.slice(0, period).reduce((x, y) => x + y, 0) / period;
  for (let i = period; i < trs.length; i++) a = (a * (period - 1) + trs[i]) / period;
  return a;
}

export function computeIndicators(candles: Candle[]): IndicatorSet {
  const closes = candles.map((c) => c.close);
  const vols = candles.map((c) => c.volume);
  const volAvg = candles.length > 1 ? sma(vols.slice(0, -1), Math.min(20, vols.length - 1)) : null;
  const lastVol = vols.length ? vols[vols.length - 1] : null;
  return {
    ema9: ema(closes, 9),
    ema21: ema(closes, 21),
    sma20: sma(closes, 20),
    sma50: sma(closes, 50),
    rsi14: rsi(closes, 14),
    macd: macd(closes),
    vwap: vwap(candles),
    volumeAvg20: volAvg,
    volumeSpike: volAvg && volAvg > 0 && lastVol !== null ? lastVol / volAvg : null,
    atr14: atr(candles, 14),
  };
}
