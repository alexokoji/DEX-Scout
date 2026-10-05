/**
 * USD price of a chain's wrapped native token from DexScreener pairs.
 *
 * A pair's `priceUsd` is the price of its BASE token. The deepest pool for a wrapped native is usually something like
 * USDC/WHYPE, where WHYPE is the QUOTE token, so reading `priceUsd` blindly returns the price of USDC ($1) — which is
 * exactly what happened on HyperEVM (HYPE priced at $0.9998 instead of about $94, so a "$10" buy would have been sized
 * as roughly $940 of HYPE). When the wrapped token is the quote, its USD price is `priceUsd / priceNative`.
 */
export interface DsNativePair {
  chainId?: string;
  priceUsd?: string;
  priceNative?: string;
  baseToken?: { address?: string };
  quoteToken?: { address?: string };
  liquidity?: { usd?: number };
}

const MIN_LIQUIDITY_USD = 5_000;

export function nativeUsdFromPairs(pairs: DsNativePair[], wrapped: string, dexScreenerChainId: string): number | null {
  const w = wrapped.toLowerCase();
  const points: { price: number; liq: number }[] = [];
  for (const p of pairs) {
    if (p.chainId !== dexScreenerChainId) continue;
    const liq = p.liquidity?.usd ?? 0;
    if (liq < MIN_LIQUIDITY_USD) continue;
    const usd = Number(p.priceUsd);
    const native = Number(p.priceNative);
    let price = NaN;
    if (p.baseToken?.address?.toLowerCase() === w) price = usd;
    else if (p.quoteToken?.address?.toLowerCase() === w && native > 0) price = usd / native;
    if (price > 0 && Number.isFinite(price)) points.push({ price, liq });
  }
  if (!points.length) return null;
  // the deepest few pools, then their median: one oddly priced pool can't move it
  const top = points.sort((a, b) => b.liq - a.liq).slice(0, 5).map((x) => x.price).sort((a, b) => a - b);
  return top[Math.floor(top.length / 2)];
}
