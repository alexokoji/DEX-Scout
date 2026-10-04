import { describe, expect, it } from "vitest";
import { runBacktest } from "@/core/strategy/engine";
import { allocate, capitalSnapshot, checkManualAmount } from "@/core/trading/capital";
import { assessPosition } from "@/core/trading/emergency";
import { applySell, computeMetrics, deriveStatus } from "@/core/trading/positions";
import { evaluateTargets, validateTargets } from "@/core/trading/targets";
import { validateEntry, validateSlippage } from "@/core/trading/validation";
import { DEFAULT_TARGETS_MULTI, DEFAULT_TARGETS_SINGLE } from "@/core/config";
import { constantProductImpactPct, quoteFromImpact } from "@/core/trading/quoteMath";
import { liveTokenIndices, onChainAt, snapshotAt, tokenSpec } from "@/core/providers/mock/world";
import { analysisFor, NOW_MIN } from "./helpers";

const pos = (o = {}) => ({ entryPriceUsd: 1, initialAmount: 100, amount: 100, costBasisUsd: 100, targetsHit: 0, ...o });

describe("profit targets", () => {
  it("single target sells 100% at +10%", () => {
    expect(evaluateTargets(pos(), 1.09, DEFAULT_TARGETS_SINGLE)).toHaveLength(0);
    const a = evaluateTargets(pos(), 1.1, DEFAULT_TARGETS_SINGLE);
    expect(a).toHaveLength(1);
    expect(a[0].sellAmount).toBe(100);
    expect(a[0].isFinal).toBe(true);
  });

  it("multi target: +8% sells 25%, +15% another 25%, +25% another 25%, +40% the remainder", () => {
    let p = pos();
    const steps: [number, number][] = [[1.08, 25], [1.15, 25], [1.25, 25], [1.4, 25]];
    for (const [price, expected] of steps) {
      const acts = evaluateTargets(p, price, DEFAULT_TARGETS_MULTI);
      expect(acts).toHaveLength(1);
      expect(acts[0].sellAmount).toBeCloseTo(expected, 6);
      p = { ...p, amount: p.amount - acts[0].sellAmount, targetsHit: p.targetsHit + 1 };
    }
    expect(p.amount).toBeCloseTo(0, 6);
  });

  it("a price gap crossing several targets returns each in order, never re-selling a hit target", () => {
    const acts = evaluateTargets(pos(), 1.3, DEFAULT_TARGETS_MULTI);
    expect(acts.map((a) => a.level)).toEqual([1, 2, 3]);
    expect(evaluateTargets(pos({ targetsHit: 2, amount: 50 }), 1.3, DEFAULT_TARGETS_MULTI).map((a) => a.level)).toEqual([3]);
  });

  it("NEVER sells a losing position: -5%, -10%, -20%, -90% produce no action (no stop loss)", () => {
    for (const p of [0.95, 0.9, 0.8, 0.1]) expect(evaluateTargets(pos(), p, DEFAULT_TARGETS_MULTI)).toEqual([]);
  });

  it("validates ladders", () => {
    expect(validateTargets(DEFAULT_TARGETS_MULTI)).toBeNull();
    expect(validateTargets([{ level: 1, gainPct: 10, sellPct: 50 }, { level: 2, gainPct: 5, sellPct: 50 }])).toMatch(/increase/);
    expect(validateTargets([])).toMatch(/At least one/);
  });
});

describe("position calculations", () => {
  it("computes unrealised P/L and target progress", () => {
    const m = computeMetrics(pos(), 1.04, DEFAULT_TARGETS_MULTI);
    expect(m.currentValueUsd).toBeCloseTo(104);
    expect(m.unrealizedPnlUsd).toBeCloseTo(4);
    expect(m.pnlPct).toBeCloseTo(4);
    expect(m.nextTargetLevel).toBe(1);
    expect(m.targetProgress).toBeCloseTo(0.5);
  });

  it("a loss is just OPEN", () => {
    expect(deriveStatus({ closed: false, emergency: false, targetsHit: 0, unrealizedPnlUsd: -20 })).toBe("OPEN");
    expect(deriveStatus({ closed: false, emergency: false, targetsHit: 0, unrealizedPnlUsd: 3 })).toBe("PROFITABLE");
    expect(deriveStatus({ closed: false, emergency: false, targetsHit: 2, unrealizedPnlUsd: 3 })).toBe("TARGET_2");
    expect(deriveStatus({ closed: false, emergency: true, targetsHit: 0, unrealizedPnlUsd: -3 })).toBe("EMERGENCY");
  });

  it("applySell tracks realised P/L and cost basis proportionally", () => {
    const r = applySell({ ...pos(), realizedPnlUsd: 0 }, 25, 27);
    expect(r.amount).toBe(75);
    expect(r.costBasisUsd).toBeCloseTo(75);
    expect(r.realizedDeltaUsd).toBeCloseTo(2);
    const done = applySell({ ...pos(), realizedPnlUsd: 0 }, 100, 90);
    expect(done.closed).toBe(true);
    expect(done.realizedPnlUsd).toBeCloseTo(-10);
  });
});

describe("capital allocation", () => {
  // no typed-in "trading capital": the wallet balance is the capital, optionally capped by maxDeployedUsd
  const s = { maxPositionUsd: 10, minPositionUsd: 5, maxOpenPositions: 10, maxDeployedUsd: 100 as number | null };
  const st = (deployedUsd: number, openPositions: number, walletUsd?: number | null) => ({ deployedUsd, openPositions, walletUsd });
  it("never allocates above the max position size", () => {
    expect(allocate(s, st(0, 0, 1_000), 50)).toEqual({ ok: true, amountUsd: 10 });
  });
  it("never exceeds the wallet balance or the optional max deployed", () => {
    expect(allocate(s, st(96, 9, 1_000), 10).ok).toBe(false); // deployed cap nearly reached
    expect(allocate({ ...s, maxDeployedUsd: 40 }, st(37, 4, 1_000), 10).ok).toBe(false);
    expect(allocate(s, st(92, 9, 1_000), 10)).toEqual({ ok: true, amountUsd: 8 });
    expect(allocate(s, st(0, 0, 7), 10)).toEqual({ ok: true, amountUsd: 7 }); // wallet holds only $7
    expect(allocate(s, st(0, 0, 3), 10)).toMatchObject({ ok: false }); // below the $5 minimum position
  });
  it("an empty wallet blocks with a reason that says so", () => {
    expect(allocate(s, st(0, 0, 0), 10)).toMatchObject({ ok: false, reason: expect.stringMatching(/wallet has no balance/) });
    expect(allocate(s, st(100, 3, 500), 10)).toMatchObject({ ok: false, reason: expect.stringMatching(/Maximum capital deployed/) });
  });
  it("with no deployed cap, only the wallet limits spending", () => {
    const open = { ...s, maxDeployedUsd: null };
    expect(allocate(open, st(5_000, 3, 800), 10)).toEqual({ ok: true, amountUsd: 10 });
    expect(capitalSnapshot(open, st(5_000, 3, 800))).toMatchObject({ walletUsd: 800, availableUsd: 800 });
  });
  it("an unknown wallet balance (no wallet, or RPC down) is not treated as zero", () => {
    expect(allocate(s, st(0, 0, null), 10)).toEqual({ ok: true, amountUsd: 10 });
    expect(allocate({ ...s, maxDeployedUsd: null }, st(0, 0), 10)).toEqual({ ok: true, amountUsd: 10 });
    expect(capitalSnapshot({ ...s, maxDeployedUsd: null }, st(0, 0, null)).availableUsd).toBeNull();
    expect(capitalSnapshot(s, st(30, 3, null))).toMatchObject({ walletUsd: null, availableUsd: 70 }); // the cap still applies
  });
  it("enforces max open positions", () => {
    expect(allocate(s, st(50, 10, 1_000), 10)).toMatchObject({ ok: false });
    expect(capitalSnapshot(s, st(30, 3, 1_000))).toMatchObject({ availableUsd: 70, slotsLeft: 7 });
    expect(capitalSnapshot(s, st(30, 3, 40))).toMatchObject({ availableUsd: 40 }); // the wallet is the tighter limit
  });
  it("rejects invalid or tiny amounts", () => {
    expect(allocate(s, st(0, 0, 1_000), -1).ok).toBe(false);
    expect(allocate(s, st(0, 0, 1_000), NaN).ok).toBe(false);
    expect(allocate(s, st(0, 0, 1_000), 2).ok).toBe(false);
  });
  it("10 positions of $10 exactly fill a $100 deployed cap and the 11th is refused", () => {
    let deployed = 0;
    for (let i = 0; i < 10; i++) {
      expect(allocate(s, st(deployed, i, 1_000), 10).ok).toBe(true);
      deployed += 10;
    }
    expect(allocate(s, st(deployed, 10, 1_000), 10).ok).toBe(false);
  });
  it("manual amounts are checked without silent shrinking", () => {
    expect(checkManualAmount(s, st(0, 0, 1_000), 11)).toMatch(/maximum position/);
    expect(checkManualAmount(s, st(0, 0, 1_000), 8)).toBeNull();
    expect(checkManualAmount(s, st(0, 0, 6), 8)).toMatch(/wallet balance/);
    expect(checkManualAmount(s, st(95, 3, 1_000), 8)).toMatch(/available capital/);
    expect(checkManualAmount(s, st(0, 0, null), 8)).toBeNull();
  });
});

describe("trade validation & price impact", () => {
  const limits = { maxPriceImpactPct: 2, maxSlippageBps: 300, minLiquidityUsd: 100_000, minVolume24hUsd: 50_000, minOpportunityScore: 70, maxAllowedRisk: "MODERATE" as const };
  const a = analysisFor(liveTokenIndices(NOW_MIN)[0]);
  const mkQuote = (impact: number) => quoteFromImpact({ chain: "solana", side: "BUY", tokenAddress: "x", priceUsd: 1, amountUsd: 10, impactPct: impact, slippageBps: 100, priorityFeeNative: 0.0001, route: ["r"], source: "MOCK" });
  const cand = (impact: number) => ({ liquidityUsd: 500_000, volume24hUsd: 500_000, opportunityScore: 80, safety: { riskScore: 5, riskLevel: "LOWER" as const, passed: true, warnings: [], criticalIssues: [] }, quote: mkQuote(impact), sellSimulationOk: true });

  it("computes constant-product price impact", () => {
    expect(constantProductImpactPct(1000, 200_000)).toBeCloseTo((1000 / 101_000) * 100, 6);
    expect(constantProductImpactPct(10, 0)).toBe(100);
  });
  it("accepts a clean candidate", () => {
    expect(validateEntry(cand(0.5), limits, { automatic: true })).toEqual([]);
  });
  it("rejects excessive price impact", () => {
    expect(validateEntry(cand(3.5), limits, { automatic: false }).join()).toMatch(/Price impact/);
  });
  it("rejects expired quotes, low score (auto only), high risk (auto) and critical issues", () => {
    const expired = { ...cand(0.5), quote: { ...mkQuote(0.5), expiresAt: new Date(Date.now() - 1000) } };
    expect(validateEntry(expired, limits, { automatic: false }).join()).toMatch(/expired/);
    expect(validateEntry({ ...cand(0.5), opportunityScore: 40 }, limits, { automatic: true }).join()).toMatch(/score/);
    expect(validateEntry({ ...cand(0.5), opportunityScore: 40 }, limits, { automatic: false })).toEqual([]);
    expect(validateEntry({ ...cand(0.5), safety: { ...cand(0.5).safety, riskLevel: "HIGH" } }, limits, { automatic: true }).join()).toMatch(/Risk level/);
    expect(validateEntry({ ...cand(0.5), safety: { ...cand(0.5).safety, criticalIssues: ["rug"] } }, limits, { automatic: false }).join()).toMatch(/Critical/);
    expect(validateEntry({ ...cand(0.5), sellSimulationOk: false }, limits, { automatic: false }).join()).toMatch(/Sell simulation/);
  });
  it("validates slippage", () => {
    expect(validateSlippage(100, 300)).toBeNull();
    expect(validateSlippage(500, 300)).toMatch(/exceeds/);
    expect(validateSlippage(0, 300)).toMatch(/positive/);
    void a;
  });
});

describe("emergency conditions", () => {
  const spec = tokenSpec(liveTokenIndices(NOW_MIN)[0]);
  const snap = snapshotAt(spec, NOW_MIN);
  const raw = onChainAt(spec, NOW_MIN);
  const base = { snapshot: snap, raw: { ...raw, poolActive: true, sellSimulationOk: true }, safety: null, market: null, onchain: null, liquidityAtEntryUsd: snap.liquidityUsd, positionValueUsd: 10 };
  const cfg = { enabled: true, liquidityDropPct: 70 };

  it("does not treat price loss as an emergency (no price input exists)", () => {
    const r = assessPosition(base, cfg);
    expect(r.emergency).toBe(false);
    expect(r.health).toBe("HOLD");
  });
  it("triggers on pool disappearing, sell-sim failure, untradeable token, liquidity collapse", () => {
    expect(assessPosition({ ...base, raw: { ...base.raw, poolActive: false } }, cfg).emergency).toBe(true);
    expect(assessPosition({ ...base, raw: { ...base.raw, sellSimulationOk: false } }, cfg).emergency).toBe(true);
    expect(assessPosition({ ...base, snapshot: null, raw: null }, cfg).emergency).toBe(true);
    expect(assessPosition({ ...base, liquidityAtEntryUsd: snap.liquidityUsd * 10 }, cfg).emergency).toBe(true);
  });
  it("is inert when disabled but still reports the health state", () => {
    const r = assessPosition({ ...base, raw: { ...base.raw, poolActive: false } }, { ...cfg, enabled: false });
    expect(r.emergency).toBe(false);
    expect(r.health).toBe("EMERGENCY");
  });
  it("WARNING when liquidity, volume and whales turn negative, without becoming an emergency", () => {
    const a = analysisFor(liveTokenIndices(NOW_MIN)[0]);
    const r = assessPosition({ ...base, market: { ...a.market, buySellRatio: 0.5, volumeMomentum: -0.8, liquidityTrend: -20 }, onchain: { ...a.onchain, whaleBias: "DISTRIBUTION", holderGrowthPct1h: -3 } }, cfg);
    expect(r.health).toBe("WARNING");
    expect(r.emergency).toBe(false);
  });
});

describe("backtest foundation", () => {
  it("replays bars with profit targets and reports stats, holding losers", () => {
    const bars = [1, 1, 0.9, 0.8, 0.85, 1.0, 1.1, 1.2, 1.3, 1.5].map((price, i) => ({ time: i * 60, price, volume: 1000, liquidityUsd: 100_000 }));
    const r = runBacktest(bars, { name: "enter-first", shouldEnter: (h) => h.length === 1 }, { capitalUsd: 100, positionUsd: 10, maxOpenPositions: 1, targets: DEFAULT_TARGETS_SINGLE, feeBps: 0, markToMarketAtEnd: true });
    expect(r.trades).toHaveLength(1);
    expect(r.trades[0].closed).toBe(true);
    expect(r.trades[0].realizedPnlUsd).toBeCloseTo(1, 6); // held through -20% and sold at +10%
    expect(r.maxDrawdownPct).toBeGreaterThan(0);
    expect(r.winRate).toBe(1);
    expect(r.disclaimer).toMatch(/do not prove/);
  });
});