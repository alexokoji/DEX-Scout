import { describe, expect, it } from "vitest";
import { DEFAULT_FILTERS } from "@/core/config";
import { applyFilters, mergeFilters } from "@/core/scanner/filter";
import { allSnapshots, makeSnapshot } from "./helpers";

describe("token filtering", () => {
  it("passes a token inside every default band", () => {
    expect(applyFilters(makeSnapshot(), DEFAULT_FILTERS).passed).toBe(true);
  });

  it("filters by market cap in both directions (defaults $1M–$10M)", () => {
    expect(applyFilters(makeSnapshot({ marketCapUsd: 999_999 }), DEFAULT_FILTERS).reasons).toContain("Market cap below minimum");
    expect(applyFilters(makeSnapshot({ marketCapUsd: 10_000_001 }), DEFAULT_FILTERS).reasons).toContain("Market cap above maximum");
    expect(applyFilters(makeSnapshot({ marketCapUsd: 1_000_000 }), DEFAULT_FILTERS).passed).toBe(true);
    expect(applyFilters(makeSnapshot({ marketCapUsd: 10_000_000 }), DEFAULT_FILTERS).passed).toBe(true);
  });

  it("market-cap band is configurable", () => {
    const f = { ...DEFAULT_FILTERS, minMarketCapUsd: 20_000_000, maxMarketCapUsd: 50_000_000 };
    expect(applyFilters(makeSnapshot({ marketCapUsd: 25_000_000 }), f).passed).toBe(true);
    expect(applyFilters(makeSnapshot({ marketCapUsd: 5_000_000 }), f).passed).toBe(false);
  });

  it("filters by liquidity, volume, holders, age, tx count", () => {
    expect(applyFilters(makeSnapshot({ liquidityUsd: 50_000 }), DEFAULT_FILTERS).reasons).toContain("Liquidity below minimum");
    expect(applyFilters(makeSnapshot({ volume24h: 10_000 }), DEFAULT_FILTERS).reasons).toContain("24h volume below minimum");
    expect(applyFilters(makeSnapshot({ holders: 10 }), DEFAULT_FILTERS).reasons).toContain("Holder count below minimum");
    expect(applyFilters(makeSnapshot({ poolCreatedAt: new Date(Date.now() - 90 * 24 * 3_600_000) }), DEFAULT_FILTERS).reasons).toContain("Token older than maximum age");
    expect(applyFilters(makeSnapshot({ buys1h: 5, sells1h: 5 }), DEFAULT_FILTERS).reasons).toContain("Transaction count below minimum");
  });

  it("unknown holder counts (-1) are not penalised", () => {
    expect(applyFilters(makeSnapshot({ holders: -1 }), DEFAULT_FILTERS).passed).toBe(true);
  });

  it("rejects when price impact of the probe order is too high", () => {
    const r = applyFilters(makeSnapshot({ liquidityUsd: 100_000 }), { ...DEFAULT_FILTERS, minLiquidityUsd: 0, priceImpactProbeUsd: 10_000, maxPriceImpactPct: 3 });
    expect(r.passed).toBe(false);
    expect(r.reasons.some((x) => x.startsWith("Price impact"))).toBe(true);
  });

  it("supports DEX filtering", () => {
    expect(applyFilters(makeSnapshot({ dex: "Orca" }), { ...DEFAULT_FILTERS, dexes: ["raydium"] }).passed).toBe(false);
    expect(applyFilters(makeSnapshot({ dex: "Raydium" }), { ...DEFAULT_FILTERS, dexes: ["raydium"] }).passed).toBe(true);
  });

  it("merging filters yields the union envelope", () => {
    const m = mergeFilters([DEFAULT_FILTERS, { ...DEFAULT_FILTERS, minMarketCapUsd: 500_000, maxMarketCapUsd: 5_000_000 }])!;
    expect(m.minMarketCapUsd).toBe(500_000);
    expect(m.maxMarketCapUsd).toBe(10_000_000);
  });

  it("does not cap how many mock tokens the discovery emits or how many pass", () => {
    const snaps = allSnapshots();
    expect(snaps.length).toBeGreaterThan(50);
    const passing = snaps.filter((s) => applyFilters(s, DEFAULT_FILTERS, new Date()).passed);
    expect(passing.length).toBeGreaterThan(10);
  });
});