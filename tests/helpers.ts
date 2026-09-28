import { buildAnalysis } from "@/core/analysis/pipeline";
import { candlesAt, liveTokenIndices, onChainAt, snapshotAt, toMinute, tokenSpec } from "@/core/providers/mock/world";
import type { Analysis, TokenSnapshot } from "@/core/types";

export const NOW_MIN = toMinute(new Date("2026-09-20T12:00:00Z"));

export function allSnapshots(): TokenSnapshot[] {
  return liveTokenIndices(NOW_MIN).map((i) => snapshotAt(tokenSpec(i), NOW_MIN));
}

export function analysisFor(index: number): Analysis {
  const spec = tokenSpec(index);
  const snap = snapshotAt(spec, NOW_MIN);
  return buildAnalysis(snap, onChainAt(spec, NOW_MIN), candlesAt(spec, NOW_MIN, "5m", 120), "5m", undefined, new Date(NOW_MIN * 60_000));
}

export function makeSnapshot(over: Partial<TokenSnapshot> = {}): TokenSnapshot {
  return {
    chain: "solana", address: "A".repeat(44), name: "Test", symbol: "TST", decimals: 6, dex: "Raydium", poolAddress: "P".repeat(44),
    poolCreatedAt: new Date(Date.now() - 48 * 3_600_000), pairCount: 1, priceUsd: 0.01, marketCapUsd: 5_000_000, fdvUsd: 5_000_000,
    liquidityUsd: 300_000, liquidity1hAgoUsd: 300_000, volume5m: 5_000, volume15m: 15_000, volume30m: 30_000, volume1h: 60_000, volume24h: 800_000,
    buys5m: 30, sells5m: 20, buys15m: 90, sells15m: 60, buys1h: 400, sells1h: 300, change5m: 1, change1h: 3, change24h: 10, holders: 1500, holders1hAgo: 1480,
    observedAt: new Date(), dataSource: "MOCK", ...over,
  };
}