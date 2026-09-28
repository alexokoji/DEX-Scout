import { DEFAULT_WEIGHTS } from "../config";
import type { MarketAnalysis, OnChainAnalysis, OpportunityScore, ScoreComponent, ScoreWeights, TokenSnapshot } from "../types";

const c01 = (n: number) => Math.min(1, Math.max(0, n));

function ageValue(hours: number): number {
  if (hours < 1) return 0.2;
  if (hours < 6) return 0.5;
  if (hours < 24 * 7) return 1;
  if (hours < 24 * 30) return 0.8;
  return 0.5;
}

/** Re-weight stored component values with a user's own weights (the shared scanner scores with defaults). */
export function rescore(components: ScoreComponent[], weights: ScoreWeights): OpportunityScore {
  const total = components.reduce((s, c) => s + Math.max(0, weights[c.key]), 0) || 1;
  const score = (components.reduce((s, c) => s + c.value * Math.max(0, weights[c.key]), 0) / total) * 100;
  return { score: Math.round(score * 10) / 10, components: components.map((c) => ({ ...c, weight: weights[c.key] })) };
}

/**
 * Weighted 0–100 "opportunity" score. It ranks how well current conditions match the strategy's criteria;
 * it is an analytical metric and NOT a probability of profit.
 */
export function scoreOpportunity(
  snap: TokenSnapshot,
  market: MarketAnalysis,
  onchain: OnChainAnalysis,
  weights: ScoreWeights = DEFAULT_WEIGHTS,
  now = new Date(),
): OpportunityScore {
  const ageHours = (now.getTime() - snap.poolCreatedAt.getTime()) / 3_600_000;
  const turnover = snap.marketCapUsd > 0 ? snap.volume24h / snap.marketCapUsd : 0;
  const spike = market.indicators.volumeSpike ?? 1;
  const tx1h = snap.buys1h + snap.sells1h;
  const holdersKnown = snap.holders > 0 && snap.holders1hAgo > 0;

  const liqTrend = market.liquidityTrend;
  const stability = liqTrend < 0 ? 1 - c01(-liqTrend / 25) : 0.7 + Math.min(0.3, liqTrend / 50);

  const values: Record<keyof ScoreWeights, [string, number]> = {
    liquidity: ["Liquidity", c01(Math.log10(Math.max(1, snap.liquidityUsd) / 25_000) / Math.log10(16))],
    volume: ["Volume", c01(0.6 * Math.min(1, turnover / 0.4) + 0.4 * Math.min(1, Math.max(0, spike - 1) / 2))],
    momentum: ["Momentum", c01((market.priceMomentum + 1) / 2 - (market.overextended ? 0.25 : 0))],
    buySellPressure: ["Buy/Sell Pressure", c01((market.buySellRatio - 0.8) / 1.2)],
    priceStructure: ["Price Structure", market.structureScore],
    holderGrowth: [
      "Holder Growth",
      holdersKnown ? c01(0.3 + (onchain.holderGrowthPct1h >= 0 ? onchain.holderGrowthPct1h / 5 : onchain.holderGrowthPct1h / 15) * 0.7) : 0.4,
    ],
    txActivity: ["Transaction Activity", c01(0.6 * Math.min(1, tx1h / 400) + 0.4 * ((market.txMomentum + 1) / 2))],
    tokenAge: ["Token Age", ageValue(ageHours)],
    liquidityStability: ["Liquidity Stability", c01(stability)],
  };

  const keys = Object.keys(values) as (keyof ScoreWeights)[];
  const totalWeight = keys.reduce((s, k) => s + Math.max(0, weights[k]), 0) || 1;
  const components: ScoreComponent[] = keys.map((key) => ({
    key,
    label: values[key][0],
    value: values[key][1],
    weight: weights[key],
  }));
  const score = (components.reduce((s, c) => s + c.value * Math.max(0, c.weight), 0) / totalWeight) * 100;
  return { score: Math.round(score * 10) / 10, components };
}
