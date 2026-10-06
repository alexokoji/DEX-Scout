import type { Candle, ProfitTargetConfig } from "../types";

/**
 * What a token has actually done, turned into what to expect from it. For every moment in its recent price history, how far did
 * the price climb at its best over the next hour, four hours, a day? The spread of those answers is the base rate for THIS token:
 * "from a random moment, the price topped out 8% higher within 4 hours half the time, 15% a quarter of the time, 31% one time in
 * ten", along with how far it typically dipped on the way. That is what a profit target should be set against.
 *
 * It is a base rate, not a forecast. It assumes the token keeps behaving the way it has lately, and it says how much history it
 * rests on so that a thin one can be discounted. Nothing here predicts a move, and no figure in it is chosen by us: the numbers
 * are the token's own history. (The only choices are the presets in `suggestLadder`, which pick points on that curve.)
 */

/** points on the distribution kept for each horizon: the value at 0%, 5%, 10% ... 100% of windows */
const TABLE_STEPS = 21;
/** the fewest windows a horizon needs before its figures are shown at all: with fewer, a percentile is one or two lucky moments */
export const MIN_WINDOWS = 24;

export interface RiseStats {
  horizonMin: number;
  label: string;
  /** how many starting moments the figures are drawn from */
  windows: number;
  /** roughly how many non-overlapping horizons the history holds (the windows overlap, so this is the honest sample size) */
  independent: number;
  /** the best rise reached within the horizon, from a random starting moment: the middle, upper-quarter and upper-tenth outcomes (%) */
  p50: number;
  p75: number;
  p90: number;
  /** how far it typically fell below the starting price at some point within the horizon (a negative %, the median) */
  typicalDip: number;
  /** the whole distribution of best rises, sorted ascending, sampled at 0%, 5% ... 100% of windows (for hit rates and ladders) */
  riseTable: number[];
}

export interface Projection {
  basedOn: { candles: number; spanHours: number; timeframeMin: number };
  horizons: RiseStats[];
  /** how big the latest candles' swings are against the whole history: above 1 means it is moving more than usual right now */
  volatility: { recentPct: number; typicalPct: number; ratio: number } | null;
  computedAt: string;
}

export const horizonLabel = (min: number) => (min >= 1440 ? `${Math.round(min / 1440)}d` : min >= 60 ? `${Math.round(min / 60)}h` : `${min}m`);

function quantile(sorted: number[], q: number): number {
  if (!sorted.length) return 0;
  const pos = Math.min(1, Math.max(0, q)) * (sorted.length - 1);
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

/** Candles must be oldest first. Returns null when there isn't enough history for even the shortest horizon. */
export function projectRise(candles: Candle[], timeframeMin: number, horizonsMin: number[] = [60, 240, 1440], now = new Date()): Projection | null {
  const c = candles.filter((x) => x.close > 0 && x.high >= x.low).sort((a, b) => a.time - b.time);
  if (c.length < 2 || !(timeframeMin > 0)) return null;
  const horizons: RiseStats[] = [];
  for (const horizonMin of horizonsMin) {
    const h = Math.max(1, Math.round(horizonMin / timeframeMin));
    const rises: number[] = [];
    const dips: number[] = [];
    for (let i = 0; i + h < c.length; i++) {
      const entry = c[i].close;
      let hi = -Infinity;
      let lo = Infinity;
      for (let j = i + 1; j <= i + h; j++) {
        if (c[j].high > hi) hi = c[j].high;
        if (c[j].low < lo) lo = c[j].low;
      }
      rises.push(Math.max(0, (hi / entry - 1) * 100));
      dips.push(Math.min(0, (lo / entry - 1) * 100));
    }
    if (rises.length < MIN_WINDOWS) continue;
    const sorted = [...rises].sort((a, b) => a - b);
    horizons.push({
      horizonMin,
      label: horizonLabel(horizonMin),
      windows: rises.length,
      independent: Math.floor(c.length / h),
      p50: quantile(sorted, 0.5),
      p75: quantile(sorted, 0.75),
      p90: quantile(sorted, 0.9),
      typicalDip: quantile([...dips].sort((a, b) => a - b), 0.5),
      riseTable: Array.from({ length: TABLE_STEPS }, (_, k) => quantile(sorted, k / (TABLE_STEPS - 1))),
    });
  }
  if (!horizons.length) return null;
  const swing = (x: Candle) => ((x.high - x.low) / x.close) * 100;
  const all = c.reduce((s, x) => s + swing(x), 0) / c.length;
  const recentN = Math.min(c.length, Math.max(3, Math.round(60 / timeframeMin)));
  const recent = c.slice(-recentN).reduce((s, x) => s + swing(x), 0) / recentN;
  return {
    basedOn: { candles: c.length, spanHours: ((c[c.length - 1].time - c[0].time) / 3600) + (timeframeMin / 60), timeframeMin },
    horizons,
    volatility: all > 0 ? { recentPct: recent, typicalPct: all, ratio: recent / all } : null,
    computedAt: now.toISOString(),
  };
}

/** A horizon needs at least this many separate stretches of history behind it to be the one targets are drawn from by default. */
export const MIN_INDEPENDENT = 5;

/**
 * The window targets are drawn from unless someone picks another: the longest one with real history behind it. A position is held until
 * a target is reached (there is no stop loss), so a longer window describes it better than a short one; but a window the history
 * barely covers (a day, from ten days of candles, is about ten separate days) is a rougher guide, so a longer window is used only while
 * it has enough separate stretches behind it. If none does, the best-supported one.
 */
export function defaultHorizon(p: Projection): RiseStats | null {
  if (!p.horizons.length) return null;
  const supported = p.horizons.filter((h) => h.independent >= MIN_INDEPENDENT);
  if (supported.length) return supported[supported.length - 1];
  return p.horizons.reduce((best, h) => (h.independent > best.independent ? h : best), p.horizons[0]);
}

/** The share of windows in which the best rise reached `gainPct`, read off the stored distribution (0..1). */
export function hitRate(stats: Pick<RiseStats, "riseTable">, gainPct: number): number {
  const t = stats.riseTable;
  if (!t.length) return 0;
  if (gainPct <= t[0]) return 1;
  if (gainPct > t[t.length - 1]) return 0;
  for (let i = 1; i < t.length; i++) {
    if (gainPct <= t[i]) {
      const span = t[i] - t[i - 1];
      const at = span > 0 ? (gainPct - t[i - 1]) / span : 1;
      const q = (i - 1 + at) / (t.length - 1); // share of windows that did NOT reach it
      return 1 - q;
    }
  }
  return 0;
}

/** The rise that was reached in `rate` (0..1) of the windows: the inverse of hitRate. */
export function gainAtHitRate(stats: Pick<RiseStats, "riseTable">, rate: number): number {
  const t = stats.riseTable;
  if (!t.length) return 0;
  const pos = Math.min(1, Math.max(0, 1 - rate)) * (t.length - 1);
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return t[lo] + (t[hi] - t[lo]) * (pos - lo);
}

/**
 * Suggested ladders. Each target is the rise that was reached in a chosen share of the token's own past windows; the sell shares are
 * the user's (their default ladder's), so the shape of how they take profit stays theirs.
 *   cautious    targets the price reached in most windows (80% down to 40%): likely to fill, smaller
 *   typical     the middle of the range (60% down to 15%)
 *   ambitious   the big moves (35% down to 5%): rarely reached, large
 * The hit rates are the preset's definition, shown next to every target; a ladder can always be edited by hand.
 */
export type LadderProfile = "cautious" | "typical" | "ambitious";
export const LADDER_PROFILES: Record<LadderProfile, { from: number; to: number }> = {
  cautious: { from: 0.8, to: 0.4 },
  typical: { from: 0.6, to: 0.15 },
  ambitious: { from: 0.35, to: 0.05 },
};

export function suggestLadder(stats: RiseStats, sellShares: number[], profile: LadderProfile): ProfitTargetConfig[] | null {
  if (!sellShares.length || !(stats.p90 > 0)) return null;
  const n = sellShares.length;
  const { from, to } = LADDER_PROFILES[profile];
  const out: ProfitTargetConfig[] = [];
  let prev = 0;
  for (let i = 0; i < n; i++) {
    const rate = n === 1 ? (from + to) / 2 : from + ((to - from) * i) / (n - 1);
    // at least a tenth of a percent above the one before: ladders must strictly rise, and a flat stretch of history can repeat a value
    const gain = Math.max(Math.round(gainAtHitRate(stats, rate) * 10) / 10, Math.round((prev + 0.1) * 10) / 10);
    out.push({ level: i + 1, gainPct: gain, sellPct: sellShares[i] });
    prev = gain;
  }
  return out[0].gainPct > 0 ? out : null;
}
