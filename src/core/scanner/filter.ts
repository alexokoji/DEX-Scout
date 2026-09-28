import { constantProductImpactPct } from "../trading/quoteMath";
import type { ScannerFilters, TokenSnapshot } from "../types";

export interface FilterResult {
  passed: boolean;
  /** human-readable reasons the token was rejected (empty when passed) */
  reasons: string[];
}

/** Pure filter: decides whether a snapshot is a scanning candidate. Unknown holder counts (-1) are not penalised. */
export function applyFilters(snap: TokenSnapshot, f: ScannerFilters, now = new Date()): FilterResult {
  const reasons: string[] = [];
  if (!f.chains.includes(snap.chain)) reasons.push(`Chain ${snap.chain} not enabled`);
  if (f.dexes.length && !f.dexes.map((d) => d.toLowerCase()).includes(snap.dex.toLowerCase())) reasons.push(`DEX ${snap.dex} not enabled`);
  if (snap.marketCapUsd < f.minMarketCapUsd) reasons.push("Market cap below minimum");
  if (snap.marketCapUsd > f.maxMarketCapUsd) reasons.push("Market cap above maximum");
  if (snap.liquidityUsd < f.minLiquidityUsd) reasons.push("Liquidity below minimum");
  if (snap.volume24h < f.minVolume24hUsd) reasons.push("24h volume below minimum");
  if (snap.holders >= 0 && snap.holders < f.minHolders) reasons.push("Holder count below minimum");
  if (f.maxTokenAgeHours !== null) {
    const age = (now.getTime() - snap.poolCreatedAt.getTime()) / 3_600_000;
    if (age > f.maxTokenAgeHours) reasons.push("Token older than maximum age");
  }
  if (snap.buys1h + snap.sells1h < f.minTxCount1h) reasons.push("Transaction count below minimum");
  const impact = constantProductImpactPct(f.priceImpactProbeUsd, snap.liquidityUsd);
  if (impact > f.maxPriceImpactPct) reasons.push(`Price impact ${impact.toFixed(1)}% above maximum`);
  return { passed: reasons.length === 0, reasons };
}

/** Union envelope of several users' filters so one shared scanner serves everyone without capping results. */
export function mergeFilters(list: ScannerFilters[]): ScannerFilters | null {
  if (!list.length) return null;
  return list.reduce((a, b) => ({
    minMarketCapUsd: Math.min(a.minMarketCapUsd, b.minMarketCapUsd),
    maxMarketCapUsd: Math.max(a.maxMarketCapUsd, b.maxMarketCapUsd),
    minLiquidityUsd: Math.min(a.minLiquidityUsd, b.minLiquidityUsd),
    minVolume24hUsd: Math.min(a.minVolume24hUsd, b.minVolume24hUsd),
    minHolders: Math.min(a.minHolders, b.minHolders),
    maxTokenAgeHours:
      a.maxTokenAgeHours === null || b.maxTokenAgeHours === null ? null : Math.max(a.maxTokenAgeHours, b.maxTokenAgeHours),
    minTxCount1h: Math.min(a.minTxCount1h, b.minTxCount1h),
    maxPriceImpactPct: Math.max(a.maxPriceImpactPct, b.maxPriceImpactPct),
    priceImpactProbeUsd: Math.min(a.priceImpactProbeUsd, b.priceImpactProbeUsd),
    dexes: a.dexes.length === 0 || b.dexes.length === 0 ? [] : Array.from(new Set([...a.dexes, ...b.dexes])),
    chains: Array.from(new Set([...a.chains, ...b.chains])),
  }));
}
