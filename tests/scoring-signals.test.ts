import { describe, expect, it } from "vitest";
import { DEFAULT_WEIGHTS } from "@/core/config";
import { rescore, scoreOpportunity } from "@/core/analysis/scoring";
import { assessSafety } from "@/core/analysis/safety";
import { generateSignal } from "@/core/signals/engine";
import { liveTokenIndices, onChainAt, snapshotAt, tokenSpec } from "@/core/providers/mock/world";
import { analysisFor, makeSnapshot, NOW_MIN } from "./helpers";
import { analyzeMarket } from "@/core/analysis/market";
import { analyzeOnChain } from "@/core/analysis/onchain";

const cleanRaw = () => onChainAt(tokenSpec(liveTokenIndices(NOW_MIN)[0]), NOW_MIN);

describe("opportunity scoring", () => {
  it("returns 0..100 with a component per weight", () => {
    const snap = makeSnapshot();
    const m = analyzeMarket(snap, [], "5m");
    const o = analyzeOnChain({ ...cleanRaw() }, snap);
    const s = scoreOpportunity(snap, m, o, DEFAULT_WEIGHTS);
    expect(s.score).toBeGreaterThanOrEqual(0);
    expect(s.score).toBeLessThanOrEqual(100);
    expect(s.components).toHaveLength(9);
  });

  it("default weights sum to 100 and are configurable", () => {
    expect(Object.values(DEFAULT_WEIGHTS).reduce((a, b) => a + b, 0)).toBe(100);
    const snap = makeSnapshot({ liquidityUsd: 2_000_000 });
    const base = scoreOpportunity(snap, analyzeMarket(snap, [], "5m"), analyzeOnChain(cleanRaw(), snap));
    const liqHeavy = rescore(base.components, { ...DEFAULT_WEIGHTS, liquidity: 90 });
    expect(liqHeavy.score).toBeGreaterThan(base.score);
  });

  it("higher liquidity scores higher, all else equal", () => {
    const a = makeSnapshot({ liquidityUsd: 60_000 });
    const b = makeSnapshot({ liquidityUsd: 900_000 });
    const sc = (s: typeof a) => scoreOpportunity(s, analyzeMarket(s, [], "5m"), analyzeOnChain(cleanRaw(), s)).score;
    expect(sc(b)).toBeGreaterThan(sc(a));
  });
});

describe("safety engine", () => {
  it("flags failed sell simulation and inactive pool as critical", () => {
    const r = assessSafety(makeSnapshot(), { ...cleanRaw(), sellSimulationOk: false, poolActive: false });
    expect(r.criticalIssues.length).toBeGreaterThanOrEqual(2);
    expect(r.riskLevel).toBe("CRITICAL");
    expect(r.passed).toBe(false);
  });
  it("flags liquidity collapse", () => {
    const r = assessSafety(makeSnapshot({ liquidityUsd: 60_000, liquidity1hAgoUsd: 300_000 }), { ...cleanRaw(), mintAuthorityRevoked: true, freezeAuthorityRevoked: true, topHolderPct: 3, top10HolderPct: 20, sellSimulationOk: true, poolActive: true, suspiciousTxRatio: 0, metadataAnomalies: [] });
    expect(r.criticalIssues.join()).toMatch(/collapsed/);
  });
  it("uses risk language, never 'safe'", () => {
    const r = assessSafety(makeSnapshot(), cleanRaw());
    expect(["LOWER", "MODERATE", "HIGH", "CRITICAL"]).toContain(r.riskLevel);
  });
});

describe("signal generation", () => {
  it("never emits signals for tokens with critical issues", () => {
    const a = analysisFor(liveTokenIndices(NOW_MIN)[0]);
    const bad = { ...a, safety: { ...a.safety, criticalIssues: ["x"], riskLevel: "CRITICAL" as const } };
    expect(generateSignal(bad)).toBeNull();
  });

  it("produces uncapped BUY/WATCH signals across the mock universe with sane ranges", () => {
    const now = new Date(NOW_MIN * 60_000);
    let buys = 0;
    let watches = 0;
    for (const i of liveTokenIndices(NOW_MIN)) {
      const spec = tokenSpec(i);
      const snap = snapshotAt(spec, NOW_MIN);
      if (snap.marketCapUsd < 1e6 || snap.marketCapUsd > 1e7) continue;
      const a = analysisFor(i);
      const s = generateSignal(a, undefined, now);
      if (!s) continue;
      if (s.type === "BUY") buys++;
      if (s.type === "WATCH") watches++;
      expect(s.entryMin).toBeLessThanOrEqual(s.entryMax);
      expect(s.target1).toBeLessThan(s.target2);
      expect(s.target2).toBeLessThan(s.target3);
      expect(s.expiresAt.getTime()).toBeGreaterThan(now.getTime());
      expect(s.reasons.length).toBeGreaterThan(0);
    }
    expect(buys + watches).toBeGreaterThan(2);
  });
});