import { describe, expect, it } from "vitest";
import { assessSafety } from "@/core/analysis/safety";
import { quoteFromImpact } from "@/core/trading/quoteMath";
import { entryWarnings, validateEntry } from "@/core/trading/validation";
import type { OnChainRaw } from "@/core/types";
import { makeSnapshot } from "./helpers";

const cleanRaw: OnChainRaw = {
  mintAuthorityRevoked: true, freezeAuthorityRevoked: true, verified: true, topHolderPct: 5, top10HolderPct: 30, sellSimulationOk: true,
  metadataAnomalies: [], largeBuys1h: 0, largeSells1h: 0, largeBuyUsd1h: 0, largeSellUsd1h: 0, newHolders1h: 0, liquidityAddedUsd1h: 0,
  liquidityRemovedUsd1h: 0, suspiciousTxRatio: 0, poolActive: true,
};

describe("safety: unknown on-chain data is not treated as a finding", () => {
  // what a Solana RPC timeout used to produce: authorities "not revoked" placeholders + an anomaly
  const rpcFailed: OnChainRaw = { ...cleanRaw, mintAuthorityRevoked: false, freezeAuthorityRevoked: false, topHolderPct: 0, top10HolderPct: 0, verified: false, dataAvailable: false };

  it("an RPC failure costs one small penalty, not the ~+38 that used to push tokens over the cutoff", () => {
    const s = makeSnapshot({ chain: "solana", liquidityUsd: 80_000, liquidity1hAgoUsd: 80_000 });
    const failed = assessSafety(s, rpcFailed);
    expect(failed.passed).toBe(true);
    expect(failed.riskScore).toBeLessThan(15);
    expect(failed.warnings.join(" ")).toMatch(/unavailable/);
    expect(failed.warnings.join(" ")).not.toMatch(/Mint authority/);
  });

  it("a genuinely active mint/freeze authority (real data) is still penalised on Solana", () => {
    const s = makeSnapshot({ chain: "solana", liquidityUsd: 80_000, liquidity1hAgoUsd: 80_000 });
    const real = assessSafety(s, { ...cleanRaw, mintAuthorityRevoked: false, freezeAuthorityRevoked: false });
    expect(real.warnings.join(" ")).toMatch(/Mint authority/);
    expect(real.warnings.join(" ")).toMatch(/Freeze authority/);
    expect(real.riskScore).toBeGreaterThanOrEqual(30);
  });

  it("an un-renounced EVM owner is one moderate warning, not both a mint and a freeze warning", () => {
    const s = makeSnapshot({ chain: "ethereum", liquidityUsd: 80_000, liquidity1hAgoUsd: 80_000 });
    const r = assessSafety(s, { ...cleanRaw, mintAuthorityRevoked: false, freezeAuthorityRevoked: false });
    expect(r.warnings.filter((w) => /owner/i.test(w))).toHaveLength(1);
    expect(r.warnings.join(" ")).not.toMatch(/Freeze authority/);
    expect(r.passed).toBe(true);
  });

  it("dangerously thin liquidity is still a critical block regardless of data availability", () => {
    const r = assessSafety(makeSnapshot({ liquidityUsd: 5_000, liquidity1hAgoUsd: 5_000 }), { ...cleanRaw, dataAvailable: false });
    expect(r.criticalIssues.join(" ")).toMatch(/Liquidity critically low/);
    expect(r.passed).toBe(false);
  });
});

describe("buy-time gates: hard safety blocks, preferences warn on manual buys", () => {
  const limits = { maxPriceImpactPct: 3, maxSlippageBps: 300, minLiquidityUsd: 20_000, minVolume24hUsd: 10_000, minOpportunityScore: 65, maxAllowedRisk: "MODERATE" as const };
  const safety = { riskScore: 5, riskLevel: "LOWER" as const, passed: true, warnings: [], criticalIssues: [] };
  const mkQuote = (impact: number) => quoteFromImpact({ chain: "solana", side: "BUY", tokenAddress: "x", priceUsd: 1, amountUsd: 10, impactPct: impact, slippageBps: 100, priorityFeeNative: 0.0001, route: ["r"], source: "MOCK" });
  // liquid enough to trade safely ($15k, 0.07% impact for $10) but under the user's $20k configured minimum
  const thin = { liquidityUsd: 15_000, volume24hUsd: 5_000, opportunityScore: 50, safety, quote: mkQuote(0.07), sellSimulationOk: true };

  it("a manual buy below the configured liquidity/volume/score minimums is NOT blocked, but is warned about", () => {
    expect(validateEntry(thin, limits, { automatic: false })).toEqual([]);
    const w = entryWarnings(thin, limits).join(" | ");
    expect(w).toMatch(/Liquidity/);
    expect(w).toMatch(/volume/);
    expect(w).toMatch(/Opportunity score/);
  });

  it("the unattended bot is still held to those same minimums", () => {
    const v = validateEntry(thin, limits, { automatic: true }).join(" | ");
    expect(v).toMatch(/Liquidity below configured minimum/);
    expect(v).toMatch(/volume below configured minimum/);
  });

  it("hard limits still block manual buys: price impact, critical issues, failed sell simulation", () => {
    expect(validateEntry({ ...thin, quote: mkQuote(9) }, limits, { automatic: false }).join()).toMatch(/Price impact/);
    expect(validateEntry({ ...thin, safety: { ...safety, criticalIssues: ["rug"] } }, limits, { automatic: false }).join()).toMatch(/Critical/);
    expect(validateEntry({ ...thin, sellSimulationOk: false }, limits, { automatic: false }).join()).toMatch(/Sell simulation/);
  });

  it("a token that meets every preference produces no warnings", () => {
    const good = { ...thin, liquidityUsd: 200_000, volume24hUsd: 100_000, opportunityScore: 80 };
    expect(entryWarnings(good, limits)).toEqual([]);
  });
});
