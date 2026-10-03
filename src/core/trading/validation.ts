import type { RiskLevel, SafetyResult, SwapQuote } from "../types";

const RISK_ORDER: Record<RiskLevel, number> = { LOWER: 0, MODERATE: 1, HIGH: 2, CRITICAL: 3 };

export interface TradeLimits {
  maxPriceImpactPct: number;
  maxSlippageBps: number;
  minLiquidityUsd: number;
  minVolume24hUsd: number;
  minOpportunityScore: number;
  maxAllowedRisk: RiskLevel;
}

export interface TradeCandidate {
  liquidityUsd: number;
  volume24hUsd: number;
  opportunityScore: number;
  safety: SafetyResult;
  quote: SwapQuote;
  sellSimulationOk: boolean;
}

/**
 * Deterministic execution-eligibility check for a BUY. Both manual and automatic entries go through it
 * (auto entries additionally enforce score/risk gates via `automatic: true`). AI output is never an input.
 * Returns a list of violations; an empty list means eligible.
 */
export function validateEntry(c: TradeCandidate, l: TradeLimits, opts: { automatic: boolean; now?: Date }): string[] {
  const v: string[] = [];
  const now = opts.now ?? new Date();
  if (c.quote.expiresAt.getTime() < now.getTime()) v.push("Quote expired");
  if (c.safety.criticalIssues.length) v.push(`Critical safety issues: ${c.safety.criticalIssues.join("; ")}`);
  if (!c.sellSimulationOk) v.push("Sell simulation failed");
  if (c.quote.priceImpactPct > l.maxPriceImpactPct) {
    v.push(`Price impact ${c.quote.priceImpactPct.toFixed(2)}% exceeds limit ${l.maxPriceImpactPct}%`);
  }
  if (c.quote.slippageBps > l.maxSlippageBps) v.push(`Slippage ${c.quote.slippageBps}bps exceeds limit ${l.maxSlippageBps}bps`);
  // Your configured liquidity/volume minimums are *preferences*, not safety limits. A pool-size floor is also
  // a crude proxy for what actually matters to a given position — price impact for THIS trade size, enforced
  // above — and hard-blocking a manual buy on a number you tuned for the bot made nearly everything
  // untradeable. So: the auto bot enforces them (it trades unattended); a manual buy is warned, not blocked.
  // Genuinely dangerous liquidity (< $10k) is still a CRITICAL safety issue and blocks both, above.
  if (opts.automatic) {
    if (c.liquidityUsd < l.minLiquidityUsd) v.push("Liquidity below configured minimum");
    if (c.volume24hUsd < l.minVolume24hUsd) v.push("24h volume below configured minimum");
  }
  if (c.quote.outputAmount <= 0 || c.quote.minReceived <= 0) v.push("Quote returned no output");
  if (opts.automatic) {
    if (c.opportunityScore < l.minOpportunityScore) v.push(`Opportunity score ${c.opportunityScore.toFixed(0)} below minimum ${l.minOpportunityScore}`);
    if (RISK_ORDER[c.safety.riskLevel] > RISK_ORDER[l.maxAllowedRisk]) v.push(`Risk level ${c.safety.riskLevel} above allowed ${l.maxAllowedRisk}`);
  }
  return v;
}

/** Non-blocking notes for a manual buy: preferences the token misses, shown to the user instead of refusing the trade. */
export function entryWarnings(c: TradeCandidate, l: TradeLimits): string[] {
  const w: string[] = [];
  if (c.liquidityUsd < l.minLiquidityUsd) w.push(`Liquidity ${Math.round(c.liquidityUsd).toLocaleString()} is below your configured minimum of ${l.minLiquidityUsd.toLocaleString()}`);
  if (c.volume24hUsd < l.minVolume24hUsd) w.push(`24h volume ${Math.round(c.volume24hUsd).toLocaleString()} is below your configured minimum of ${l.minVolume24hUsd.toLocaleString()}`);
  if (c.opportunityScore < l.minOpportunityScore) w.push(`Opportunity score ${c.opportunityScore.toFixed(0)} is below your configured minimum of ${l.minOpportunityScore}`);
  if (RISK_ORDER[c.safety.riskLevel] > RISK_ORDER[l.maxAllowedRisk]) w.push(`Risk level ${c.safety.riskLevel} is above your configured maximum of ${l.maxAllowedRisk}`);
  return w;
}

export function validateSlippage(bps: number, maxBps: number): string | null {
  if (!Number.isInteger(bps) || bps < 1) return "Slippage must be a positive integer (bps)";
  if (bps > maxBps) return `Slippage exceeds allowed maximum (${maxBps} bps)`;
  if (bps > 5000) return "Slippage above 50% is never allowed";
  return null;
}
