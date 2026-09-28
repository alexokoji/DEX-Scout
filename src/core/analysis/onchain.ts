import type { OnChainAnalysis, OnChainRaw, TokenSnapshot } from "../types";

export function analyzeOnChain(raw: OnChainRaw, snap: TokenSnapshot): OnChainAnalysis {
  const net = raw.largeBuyUsd1h - raw.largeSellUsd1h;
  const gross = raw.largeBuyUsd1h + raw.largeSellUsd1h;
  const share = gross > 0 ? net / gross : 0;
  const whaleBias = share > 0.15 ? "ACCUMULATION" : share < -0.15 ? "DISTRIBUTION" : "NEUTRAL";

  const rate5 = (snap.buys5m + snap.sells5m) / 5;
  const rate1h = (snap.buys1h + snap.sells1h) / 60;
  const txAcceleration = rate1h > 0 ? Math.max(-1, Math.min(1, (rate5 / rate1h - 1) / 2)) : rate5 > 0 ? 1 : 0;

  const holderGrowth =
    snap.holders > 0 && snap.holders1hAgo > 0 ? (snap.holders / snap.holders1hAgo - 1) * 100 : 0;

  return {
    holderGrowthPct1h: holderGrowth,
    newHolders1h: raw.newHolders1h,
    largeBuys: raw.largeBuys1h,
    largeSells: raw.largeSells1h,
    whaleNetFlowUsd: net,
    whaleBias,
    topHolderPct: raw.topHolderPct,
    top10HolderPct: raw.top10HolderPct,
    txAcceleration,
    liquidityAddedUsd: raw.liquidityAddedUsd1h,
    liquidityRemovedUsd: raw.liquidityRemovedUsd1h,
    netLiquidityUsd: raw.liquidityAddedUsd1h - raw.liquidityRemovedUsd1h,
  };
}
