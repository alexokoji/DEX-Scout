/**
 * "The analysis should tell you the projected rise so you know what to expect from a token, and each position should have its own
 * target." The projection is the token's own history read as a base rate; these pin the arithmetic on histories whose answer is known.
 */
import { describe, expect, it } from "vitest";
import { defaultHorizon, gainAtHitRate, hitRate, horizonLabel, LADDER_PROFILES, MIN_INDEPENDENT, MIN_WINDOWS, projectRise, suggestLadder } from "@/core/analysis/projection";
import type { Candle } from "@/core/types";

const T0 = 1_700_000_000;
/** candles from a list of closes; high/low sit exactly at the neighbouring closes so the maths is exact */
function fromCloses(closes: number[], tfMin = 15): Candle[] {
  return closes.map((close, i) => ({ time: T0 + i * tfMin * 60, open: close, high: Math.max(close, closes[i]), low: Math.min(close, closes[i]), close, volume: 1000, buys: 10, sells: 10 }));
}
const steady = (n: number, perCandlePct: number, start = 1) => Array.from({ length: n }, (_, i) => start * (1 + perCandlePct / 100) ** i);

describe("projectRise reads a token's own history as a base rate", () => {
  it("a token that climbs 1% every candle: within 4 candles the best rise is exactly 1.01^4 - 1, from every starting point", () => {
    const p = projectRise(fromCloses(steady(200, 1)), 15, [60])!; // 60 minutes = 4 fifteen-minute candles
    const h = p.horizons[0];
    expect(h.windows).toBe(196);
    const expected = (1.01 ** 4 - 1) * 100;
    expect(h.p50).toBeCloseTo(expected, 8);
    expect(h.p90).toBeCloseTo(expected, 8);
    expect(h.typicalDip).toBe(0); // it never fell below where it started
    expect(h.label).toBe("1h");
  });

  it("a token that goes nowhere projects nothing to act on: no rise in any window", () => {
    const p = projectRise(fromCloses(Array(200).fill(1)), 15, [60])!;
    expect(p.horizons[0].p90).toBe(0);
    expect(suggestLadder(p.horizons[0], [25, 25, 50], "typical")).toBeNull();
  });

  it("a token that steps up 10% on every 8th candle and sits still between: from a random moment the best rise is 10% about half the time, otherwise 0", () => {
    const closes: number[] = [];
    let price = 1;
    for (let i = 0; i < 400; i++) {
      if (i % 8 === 0 && i > 0) price *= 1.1;
      closes.push(price);
    }
    const h = projectRise(fromCloses(closes), 15, [60])!.horizons[0]; // 4-candle horizon: a step lands inside half the windows
    expect(h.p90).toBeCloseTo(10, 6);
    expect(h.p50).toBeGreaterThanOrEqual(0);
    expect(hitRate(h, 10)).toBeGreaterThan(0.4);
    expect(hitRate(h, 10)).toBeLessThan(0.6);
    expect(hitRate(h, 10.5)).toBe(0); // it never did 10.5
    expect(hitRate(h, 0)).toBe(1);
  });

  it("measures the dip on the way: a token that drops 6% then recovers shows the drop", () => {
    const closes = [...Array(60).fill(1), ...Array(60).fill(0.94), ...Array(60).fill(1.2)];
    const p = projectRise(fromCloses(closes), 15, [240])!;
    expect(p.horizons[0].typicalDip).toBeLessThanOrEqual(0);
    expect(Math.min(...p.horizons[0].riseTable)).toBe(0);
  });

  it("keeps only horizons with enough history behind them, and says how much that is", () => {
    const p = projectRise(fromCloses(steady(60, 0.5)), 15, [60, 240, 1440])!; // 60 candles = 15 hours
    expect(p.horizons.map((h) => h.label)).toEqual(["1h", "4h"]); // a day of history doesn't exist here, so no 1-day figure
    expect(p.horizons.every((h) => h.windows >= MIN_WINDOWS)).toBe(true);
    expect(p.basedOn).toMatchObject({ candles: 60, timeframeMin: 15 });
    expect(p.basedOn.spanHours).toBeCloseTo(15, 6);
    expect(projectRise(fromCloses(steady(20, 1)), 15)).toBeNull(); // too short for any horizon
    expect(projectRise([], 15)).toBeNull();
    expect(projectRise(fromCloses(steady(100, 1)), 0)).toBeNull();
  });

  it("reports whether it is moving more than usual right now", () => {
    const calm = steady(150, 0.1);
    const wild = [...calm, ...Array.from({ length: 6 }, (_, i) => calm[calm.length - 1] * (i % 2 ? 1.08 : 0.92))];
    const candles = fromCloses(wild).map((c, i, a) => (i === 0 ? c : { ...c, high: Math.max(c.close, a[i - 1].close) * (i > 150 ? 1.05 : 1.001), low: Math.min(c.close, a[i - 1].close) * (i > 150 ? 0.95 : 0.999) }));
    const v = projectRise(candles, 15, [60])!.volatility!;
    expect(v.ratio).toBeGreaterThan(1.5);
  });

  it("ignores broken candles instead of letting them skew the figures, and sorts oldest first", () => {
    const good = fromCloses(steady(120, 1));
    const messy = [{ ...good[5], close: 0 }, ...[...good].reverse()];
    const a = projectRise(good, 15, [60])!;
    const b = projectRise(messy, 15, [60])!;
    expect(b.horizons[0].p50).toBeCloseTo(a.horizons[0].p50, 10);
  });
});

describe("hit rates and the ladders suggested from them", () => {
  // 1,000 windows whose best rise is spread evenly from 0% to 20%
  const evenly = (): ReturnType<typeof stats> => stats(Array.from({ length: 21 }, (_, k) => k)); // table of the 0%,5%...100% points: 0..20
  function stats(riseTable: number[]) {
    return { horizonMin: 240, label: "4h", windows: 500, independent: 40, p50: riseTable[10], p75: riseTable[15], p90: riseTable[18], typicalDip: -3, riseTable };
  }
  it("hit rate is the share of windows that reached a rise, and gainAtHitRate is its inverse", () => {
    const s = evenly();
    expect(hitRate(s, 10)).toBeCloseTo(0.5, 10);
    expect(hitRate(s, 15)).toBeCloseTo(0.25, 10);
    expect(hitRate(s, 20)).toBeCloseTo(0, 10);
    expect(hitRate(s, 21)).toBe(0);
    expect(gainAtHitRate(s, 0.5)).toBeCloseTo(10, 10);
    expect(gainAtHitRate(s, 0.25)).toBeCloseTo(15, 10);
    for (const r of [0.8, 0.6, 0.35, 0.1]) expect(hitRate(s, gainAtHitRate(s, r))).toBeCloseTo(r, 8);
  });
  it("presets pick points on the token's own curve, keep the user's sell shares, and rise strictly", () => {
    const s = evenly();
    const typical = suggestLadder(s, [25, 25, 25, 100], "typical")!;
    expect(typical.map((t) => t.sellPct)).toEqual([25, 25, 25, 100]);
    expect(typical.map((t) => t.level)).toEqual([1, 2, 3, 4]);
    expect(typical[0].gainPct).toBeCloseTo(gainAtHitRate(s, LADDER_PROFILES.typical.from), 1); // reached in 60% of windows
    expect(typical[3].gainPct).toBeCloseTo(gainAtHitRate(s, LADDER_PROFILES.typical.to), 1); // reached in 15%
    for (const profile of ["cautious", "typical", "ambitious"] as const) {
      const l = suggestLadder(s, [25, 25, 25, 100], profile)!;
      for (let i = 1; i < l.length; i++) expect(l[i].gainPct).toBeGreaterThan(l[i - 1].gainPct);
    }
    // ambitious aims higher than cautious at every level
    const c = suggestLadder(s, [50, 50], "cautious")!;
    const a = suggestLadder(s, [50, 50], "ambitious")!;
    expect(a[0].gainPct).toBeGreaterThan(c[0].gainPct);
    expect(a[1].gainPct).toBeGreaterThan(c[1].gainPct);
  });
  it("a single target sits in the middle of its preset's range; a flat stretch can't produce equal levels", () => {
    const one = suggestLadder(evenly(), [100], "typical")!;
    expect(one).toHaveLength(1);
    expect(one[0].gainPct).toBeCloseTo(gainAtHitRate(evenly(), (0.6 + 0.15) / 2), 1);
    const flatTop = stats([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5]); // many windows give exactly 5
    const l = suggestLadder(flatTop, [25, 25, 50], "typical")!;
    for (let i = 1; i < l.length; i++) expect(l[i].gainPct).toBeGreaterThan(l[i - 1].gainPct);
  });
  it("labels horizons", () => {
    expect([horizonLabel(30), horizonLabel(60), horizonLabel(240), horizonLabel(1440), horizonLabel(2880)]).toEqual(["30m", "1h", "4h", "1d", "2d"]);
  });
});

describe("which window targets are drawn from by default", () => {
  it("the longest one with real history behind it: ten days of candles support hours and a few days, not a month", () => {
    const p = projectRise(fromCloses(steady(1000, 0.05)), 15, [60, 240, 1440])!; // 1,000 fifteen-minute candles, about 10 days
    expect(p.horizons.map((h) => h.label)).toEqual(["1h", "4h", "1d"]);
    expect(defaultHorizon(p)!.label).toBe("1d");
    expect(p.horizons.find((h) => h.label === "1d")!.independent).toBeGreaterThanOrEqual(MIN_INDEPENDENT);
  });
  it("a window the history barely covers is passed over for a shorter, better supported one", () => {
    const p = projectRise(fromCloses(steady(400, 0.05)), 15, [60, 240, 1440])!; // about 4 days: a day is only ~4 separate days, under the bar
    expect(p.horizons.find((h) => h.label === "1d")!.independent).toBeLessThan(MIN_INDEPENDENT);
    expect(defaultHorizon(p)!.label).toBe("4h");
  });
  it("when none clears the bar, the best supported is used rather than nothing", () => {
    const p = projectRise(fromCloses(steady(60, 0.5)), 15, [240, 1440])!; // 15 hours: only 4h exists, with ~3 separate stretches
    expect(defaultHorizon(p)!.label).toBe("4h");
  });
});