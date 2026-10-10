import type { Candle } from "../types";

/**
 * Is this a good moment to BUY, by the chart? The bot should buy a dip, not a climb: it enters while the price is in the lowest part of
 * where it has recently traded, and not once it has started to rise. Judged only from the token's own recent candles.
 *
 *   range position   where the price sits between the lowest low and the highest high of the window (0% = at the low, 100% = at the top)
 *   rising           how many of the latest candles in a row closed higher than the one before
 *   already up       how far the price is above the window's low, set against the gain the first target is aiming for
 *
 * It buys when the price is in the lowest `maxRangePct` of its range, isn't in a run of rising candles, and hasn't already made the move
 * the first target is for. Nothing here predicts anything: a price at the bottom of its range can keep falling (this app holds a position
 * until its target, so a falling token is held, not sold), which is why the range position, not "the very bottom", is the test.
 */
export interface EntryTiming {
  ok: boolean;
  /** one plain sentence: why it is a good moment, or why not */
  reason: string;
  /** 0..100: where the price is in the window's range */
  rangePosPct: number;
  windowLow: number;
  windowHigh: number;
  /** candles in a row, ending at the latest, that each closed above the one before */
  risingStreak: number;
  /** how far above the window's low the price is, in % */
  upFromLowPct: number;
}

/** Two rising candles in a row is a move that has started, whatever size the candles are. */
const RISING_RUN = 2;

export function entryTiming(candles: Candle[], price: number, maxRangePct: number, firstTargetGainPct?: number): EntryTiming | null {
  const c = candles.filter((x) => x.close > 0 && x.high >= x.low).sort((a, b) => a.time - b.time);
  if (c.length < 2 || !(price > 0)) return null;
  const lo = Math.min(...c.map((x) => x.low));
  const hi = Math.max(...c.map((x) => x.high));
  let streak = 0;
  for (let i = c.length - 1; i > 0 && c[i].close > c[i - 1].close; i--) streak++;
  const base = { windowLow: lo, windowHigh: hi, risingStreak: streak };
  if (!(hi > lo)) return { ...base, ok: false, reason: "The price hasn't moved in the window, so there is no low to buy near.", rangePosPct: 50, upFromLowPct: 0 };

  const pos = Math.min(100, Math.max(0, ((price - lo) / (hi - lo)) * 100));
  const up = (price / lo - 1) * 100;
  const out = { ...base, rangePosPct: pos, upFromLowPct: up };
  if (pos > maxRangePct) return { ...out, ok: false, reason: `The price is ${pos.toFixed(0)}% of the way up its recent range (it buys only in the lowest ${maxRangePct}%): it is not at a low.` };
  if (streak >= RISING_RUN) return { ...out, ok: false, reason: `The last ${streak} candles each closed higher: it has started to climb, so it is waiting for a dip.` };
  if (firstTargetGainPct !== undefined && up >= firstTargetGainPct) return { ...out, ok: false, reason: `The price is already ${up.toFixed(1)}% above its recent low, so the +${firstTargetGainPct}% the first target aims for has largely happened.` };
  return { ...out, ok: true, reason: `The price is ${pos.toFixed(0)}% of the way up its recent range and not rising: near a low.` };
}
