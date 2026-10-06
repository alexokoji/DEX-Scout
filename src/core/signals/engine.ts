import { SIGNAL_MIN_TRUST, SIGNAL_THRESHOLDS, SIGNAL_TTL_MINUTES } from "../config";
import type { Analysis, SignalDraft } from "../types";
import { TRUST_RANK } from "../types";
import { defaultHorizon, suggestLadder } from "../analysis/projection";

export interface SignalThresholds {
  buy: number;
  watch: number;
}

/**
 * Deterministic signal generation. There is deliberately NO cap on how many signals this can emit —
 * quality (score, safety, structure) is the only gate. Returns null when a token should not be signalled.
 */
export function generateSignal(
  a: Analysis,
  thresholds: SignalThresholds = SIGNAL_THRESHOLDS,
  now = new Date(),
): SignalDraft | null {
  const { safety, market, opportunity, snapshot: s } = a;
  if (safety.criticalIssues.length > 0 || safety.riskLevel === "CRITICAL") return null;
  // A signal is the app saying "look at this one": it only says so about tokens that have earned trust. Everything else is
  // still on the Scanner, labelled, for anyone who wants to look for themselves.
  if (TRUST_RANK[a.trust.tier] < TRUST_RANK[SIGNAL_MIN_TRUST]) return null;

  // Risk drags the ranking score down slightly so equal opportunities rank lower-risk first.
  const score = Math.max(0, Math.round((opportunity.score - safety.riskScore * 0.15) * 10) / 10);
  const okRisk = safety.riskLevel === "LOWER" || safety.riskLevel === "MODERATE";

  let type: SignalDraft["type"] | null = null;
  if (score >= thresholds.buy && okRisk && market.trend !== "DOWN" && !market.overextended) type = "BUY";
  else if (score >= thresholds.watch) type = "WATCH";
  if (!type) return null;

  const price = s.priceUsd;
  const atrPct = market.indicators.atr14 && price > 0 ? market.indicators.atr14 / price : 0.02;
  const pullbackDepth = Math.min(0.06, Math.max(0.01, atrPct * 1.5));
  const supportFloor = market.support && market.support < price ? market.support : price * (1 - pullbackDepth);
  const entryMin = Math.max(price * 0.94, Math.max(supportFloor, price * (1 - pullbackDepth)));
  const entryMax = price * 1.01;

  // Price targets from what THIS token has done (its typical, good and rare rise within a window its history supports), not the same three percentages for
  // every token. Without enough history for that there are no targets to show.
  const basis = a.projection ? defaultHorizon(a.projection) : null; // the longest window the history really supports
  const ladder = basis ? suggestLadder(basis, [1, 1, 1], "typical") : null;
  const at = (i: number) => (ladder ? price * (1 + ladder[i].gainPct / 100) : null);
  const targets = { target1: at(0), target2: at(1), target3: at(2) };

  const reasons: string[] = [];
  const byKey = new Map(opportunity.components.map((c) => [c.key, c.value]));
  if ((byKey.get("liquidity") ?? 0) >= 0.7) reasons.push(`Healthy liquidity ($${Math.round(s.liquidityUsd / 1000)}K)`);
  if ((byKey.get("volume") ?? 0) >= 0.6) reasons.push(`Strong volume: $${Math.round(s.volume24h / 1000)}K over 24h`);
  if (market.breakout) reasons.push("Breakout above recent range on elevated volume");
  else if (market.pullback) reasons.push("Pullback within an established uptrend");
  if (market.trend === "UP") reasons.push("Short-term trend is up (EMA9 > EMA21)");
  if (market.buySellRatio >= 1.3) reasons.push(`Buy/sell ratio ${market.buySellRatio.toFixed(2)}`);
  if (a.onchain.whaleBias === "ACCUMULATION") reasons.push("Large wallets net accumulating");
  if (a.onchain.holderGrowthPct1h >= 1) reasons.push(`Holders +${a.onchain.holderGrowthPct1h.toFixed(1)}% in 1h`);
  if (market.liquidityTrend >= 5) reasons.push(`Liquidity growing (${market.liquidityTrend.toFixed(0)}% in 1h)`);
  if (!reasons.length) reasons.push("Composite score meets watch criteria");

  const warnings = [...safety.warnings];
  if (market.overextended) warnings.push("Price looks overextended; chasing here carries elevated risk");
  if (market.trend === "DOWN") warnings.push("Short-term trend is down");
  if (a.onchain.whaleBias === "DISTRIBUTION") warnings.push("Large wallets net distributing");
  warnings.push("Low-cap tokens are highly volatile; positions can lose most of their value");

  return {
    type,
    score,
    opportunityScore: opportunity.score,
    riskLevel: safety.riskLevel,
    priceUsd: price,
    entryMin,
    entryMax,
    ...targets,
    reasons,
    warnings,
    expiresAt: new Date(now.getTime() + SIGNAL_TTL_MINUTES * 60_000),
  };
}
