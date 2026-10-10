/**
 * "The bot should buy when the price is low, not after it has started climbing, and check the network fee it paid to buy and the fee to
 * sell, to be sure it is still in profit after all that." These pin both rules on charts and fees whose answer is known.
 */
import { describe, expect, it } from "vitest";
import { entryTiming } from "@/core/analysis/entryTiming";
import { netAfterFees } from "@/core/trading/netProfit";
import type { Candle } from "@/core/types";

const T0 = 1_700_000_000;
/** candles from closes, with each candle's high/low a hair either side of its open and close */
const chart = (closes: number[]): Candle[] =>
  closes.map((close, i) => {
    const open = i === 0 ? close : closes[i - 1];
    return { time: T0 + i * 300, open, high: Math.max(open, close) * 1.002, low: Math.min(open, close) * 0.998, close, volume: 1000, buys: 5, sells: 5 };
  });

describe("buy a dip, not a climb", () => {
  // a token that ranged between about 1.00 and 1.10
  const ranging = [1.05, 1.08, 1.1, 1.07, 1.03, 1.0, 1.02, 1.06, 1.09, 1.05, 1.02, 1.01];

  it("near the bottom of its range and not rising: a good moment", () => {
    const t = entryTiming(chart(ranging), 1.01, 35)!;
    expect(t.ok).toBe(true);
    expect(t.rangePosPct).toBeLessThan(35);
  });

  it("in the upper part of its range it is not at a low, however good the token looks", () => {
    const t = entryTiming(chart(ranging), 1.08, 35)!;
    expect(t).toMatchObject({ ok: false });
    expect(t.reason).toMatch(/not at a low/);
  });

  it("having just started to climb off the bottom (two rising candles) it waits for a dip, even while still low in the range", () => {
    const climbing = [1.05, 1.08, 1.1, 1.07, 1.03, 1.0, 1.01, 1.02, 1.03]; // the last three closes each higher
    const t = entryTiming(chart(climbing), 1.03, 60)!;
    expect(t.risingStreak).toBe(3);
    expect(t).toMatchObject({ ok: false });
    expect(t.reason).toMatch(/started to climb/);
  });

  it("one up candle is a bounce, not yet a climb", () => {
    const t = entryTiming(chart([1.1, 1.06, 1.03, 1.0, 1.01]), 1.01, 35)!;
    expect(t.risingStreak).toBe(1);
    expect(t.ok).toBe(true);
  });

  it("if it is already up by about what the first target aims for, that move has happened", () => {
    const t = entryTiming(chart(ranging), 1.01, 35, 0.5)!; // 1% above the low, against a +0.5% target
    expect(t.ok).toBe(false);
    expect(t.reason).toMatch(/already .* above its recent low/);
    expect(entryTiming(chart(ranging), 1.01, 35, 5)!.ok).toBe(true); // a +5% target still has room
  });

  it("with nothing to judge (no moves, too few candles, no price) it says so rather than buying", () => {
    expect(entryTiming(chart(Array(12).fill(1)).map((c) => ({ ...c, high: 1, low: 1 })), 1, 35)).toMatchObject({ ok: false });
    expect(entryTiming(chart([1]), 1, 35)).toBeNull();
    expect(entryTiming(chart(ranging), 0, 35)).toBeNull();
  });
});

describe("still in profit after the fee to buy and the fee to sell", () => {
  it("a gain bigger than both fees is a profit; one smaller is a loss, whatever the price did", () => {
    // 1,000 tokens bought at $0.01 ($10), now worth $10.30; $0.01 fee to buy and $0.01 to sell
    const ok = netAfterFees({ soldTokens: 1000, entryPriceUsd: 0.01, proceedsUsd: 10.3, sellFeeUsd: 0.01, buyFeesUsd: 0.01, initialAmount: 1000 });
    expect(ok.netUsd).toBeCloseTo(0.28, 10);
    expect(ok.pays).toBe(true);
    const thin = netAfterFees({ soldTokens: 1000, entryPriceUsd: 0.01, proceedsUsd: 10.015, sellFeeUsd: 0.01, buyFeesUsd: 0.01, initialAmount: 1000 });
    expect(thin.netUsd).toBeCloseTo(-0.005, 10);
    expect(thin.pays).toBe(false); // up 0.15% on price, down after fees
  });

  it("selling part of the position carries only that part of the buy fee, but pays the whole sell fee", () => {
    const r = netAfterFees({ soldTokens: 250, entryPriceUsd: 0.01, proceedsUsd: 2.6, sellFeeUsd: 0.01, buyFeesUsd: 0.02, initialAmount: 1000 });
    expect(r.costUsd).toBeCloseTo(2.5, 10);
    expect(r.buyFeeShareUsd).toBeCloseTo(0.005, 10);
    expect(r.netUsd).toBeCloseTo(2.6 - 2.5 - 0.01 - 0.005, 10);
  });

  it("a small slice at a small gain can't pay for its own sell fee, which is why a sale waits and later ones are merged", () => {
    const slice = netAfterFees({ soldTokens: 100, entryPriceUsd: 0.01, proceedsUsd: 1.03, sellFeeUsd: 0.05, buyFeesUsd: 0.01, initialAmount: 1000 });
    expect(slice.pays).toBe(false);
    const whole = netAfterFees({ soldTokens: 1000, entryPriceUsd: 0.01, proceedsUsd: 10.3, sellFeeUsd: 0.05, buyFeesUsd: 0.01, initialAmount: 1000 });
    expect(whole.pays).toBe(true);
  });
});
