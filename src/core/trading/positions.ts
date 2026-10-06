import type { ProfitTargetConfig } from "../types";
import { targetProgress, type PositionState } from "./targets";

export type PositionStatusName = "OPEN" | "TARGET_1" | "TARGET_2" | "TARGET_3" | "PROFITABLE" | "EMERGENCY" | "CLOSED";

export interface PositionMetrics {
  currentValueUsd: number;
  /** what the position has made on PRICE: what it is worth now against what the tokens cost at the price paid. This is the headline, and what the profit targets track. */
  pricePnlUsd: number;
  pricePnlPct: number;
  /** the fees (network, priority) still sitting in the cost of the tokens held */
  feesUsd: number;
  /** after those fees: value against the full cost basis, i.e. what you would have if you sold for this price right now, less only the buy fees */
  unrealizedPnlUsd: number;
  pnlPct: number;
  nextTargetLevel: number | null;
  nextTargetGainPct: number | null;
  targetProgress: number;
}

export function computeMetrics(pos: PositionState, price: number, targets: ProfitTargetConfig[]): PositionMetrics {
  const currentValueUsd = pos.amount * price;
  const unrealizedPnlUsd = currentValueUsd - pos.costBasisUsd;
  const pnlPct = pos.costBasisUsd > 0 ? (unrealizedPnlUsd / pos.costBasisUsd) * 100 : 0;
  // On a small position the fees are a large share of what was paid (a $0.01 fee on a $0.10 buy is 10%), so a token that is up
  // 2% on price reads as down 7% once they are counted. Both are true; showing only the second looked like a wrong profit figure.
  const swapCostUsd = pos.amount * pos.entryPriceUsd;
  const pricePnlUsd = currentValueUsd - swapCostUsd;
  const pricePnlPct = pos.entryPriceUsd > 0 ? (price / pos.entryPriceUsd - 1) * 100 : 0;
  const feesUsd = Math.max(0, pos.costBasisUsd - swapCostUsd);
  const p = targetProgress(pos.entryPriceUsd, price, targets, pos.targetsHit);
  return {
    currentValueUsd,
    pricePnlUsd,
    pricePnlPct,
    feesUsd,
    unrealizedPnlUsd,
    pnlPct,
    nextTargetLevel: p.nextLevel,
    nextTargetGainPct: p.nextGainPct,
    targetProgress: p.progress,
  };
}

/** Status shown to the user. PROFITABLE means up on price (as the targets see it). A losing position is simply OPEN: it is never auto-closed for being negative. */
export function deriveStatus(p: { closed: boolean; emergency: boolean; targetsHit: number; unrealizedPnlUsd: number }): PositionStatusName {
  if (p.closed) return "CLOSED";
  if (p.emergency) return "EMERGENCY";
  if (p.targetsHit > 0) return (`TARGET_${Math.min(3, p.targetsHit)}`) as PositionStatusName;
  return p.unrealizedPnlUsd > 0 ? "PROFITABLE" : "OPEN";
}

/** Apply a sell of `sellAmount` tokens at `price` and return the updated position numbers (pure). */
export function applySell(pos: PositionState & { realizedPnlUsd: number }, sellAmount: number, netProceedsUsd: number) {
  const sold = Math.min(sellAmount, pos.amount);
  const fraction = pos.amount > 0 ? sold / pos.amount : 0;
  const costRemoved = pos.costBasisUsd * fraction;
  const remaining = pos.amount - sold;
  return {
    amount: remaining <= 1e-12 ? 0 : remaining,
    costBasisUsd: remaining <= 1e-12 ? 0 : pos.costBasisUsd - costRemoved,
    realizedDeltaUsd: netProceedsUsd - costRemoved,
    realizedPnlUsd: pos.realizedPnlUsd + (netProceedsUsd - costRemoved),
    closed: remaining <= 1e-12,
  };
}
