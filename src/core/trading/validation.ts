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
  if (c.liquidityUsd < l.minLiquidityUsd) v.push("Liquidity below configured minimum");
  if (c.volume24hUsd < l.minVolume24hUsd) v.push("24h volume below configured minimum");
  if (c.quote.outputAmount <= 0 || c.quote.minReceived <= 0) v.push("Quote returned no output");
  if (opts.automatic) {
    if (c.opportunityScore < l.minOpportunityScore) v.push(`Opportunity score ${c.opportunityScore.toFixed(0)} below minimum ${l.minOpportunityScore}`);
    if (RISK_ORDER[c.safety.riskLevel] > RISK_ORDER[l.maxAllowedRisk]) v.push(`Risk level ${c.safety.riskLevel} above allowed ${l.maxAllowedRisk}`);
  }
  return v;
}

export function validateSlippage(bps: number, maxBps: number): string | null {
  if (!Number.isInteger(bps) || bps < 1) return "Slippage must be a positive integer (bps)";
  if (bps > maxBps) return `Slippage exceeds allowed maximum (${maxBps} bps)`;
  if (bps > 5000) return "Slippage above 50% is never allowed";
  return null;
}
