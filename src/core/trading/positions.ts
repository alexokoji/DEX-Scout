import type { ProfitTargetConfig } from "../types";
import { targetProgress, type PositionState } from "./targets";

export type PositionStatusName = "OPEN" | "TARGET_1" | "TARGET_2" | "TARGET_3" | "PROFITABLE" | "EMERGENCY" | "CLOSED";

export interface PositionMetrics {
  currentValueUsd: number;
  /** what the position has made on PRICE: what it is worth now against what the tokens cost at the price paid. This is the headline, and what the profit targets track. */
  pricePnlUsd: number;
  pricePnlPct: number;
  /** value against the cost basis (the swap; positions opened before fees were left out of it also carry their buy fee here) */
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
  // Profit is measured on price: the buy fee is already paid and cannot change whether the position is up or down (on a $0.10
  // buy a $0.01 fee made a token that was up 2% read as down 7%, against a target that was correctly tracking the gain).
  const swapCostUsd = pos.amount * pos.entryPriceUsd;
  const pricePnlUsd = currentValueUsd - swapCostUsd;
  const pricePnlPct = pos.entryPriceUsd > 0 ? (price / pos.entryPriceUsd - 1) * 100 : 0;
  const p = targetProgress(pos.entryPriceUsd, price, targets, pos.targetsHit);
  return {
    currentValueUsd,
    pricePnlUsd,
    pricePnlPct,
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
