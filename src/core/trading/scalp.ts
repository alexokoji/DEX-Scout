/**
 * Does a small take-profit pay for itself? A scalp aims at a few percent, and a swap costs a network fee each way plus the price it moves
 * on the way in and out; on a small position or a dear chain those costs are the whole gain. The bot only opens a position whose FIRST
 * target still makes money after them. Every cost here is what the chain's own quote reports for this swap; the exit's cost is taken to
 * be the entry's (same route, same size), which is an estimate, so it is said to be one.
 */
export interface ScalpQuoteCosts {
  networkFeeUsd: number;
  priorityFeeUsd: number;
  platformFeeUsd: number;
  priceImpactPct: number;
}

export interface ScalpEconomics {
  /** what selling the first target's share at its gain would make, before costs */
  firstTargetProfitUsd: number;
  /** the fees to get in and out, and the price moved on the way in and out of the part that is sold */
  roundTripCostUsd: number;
  netUsd: number;
  /** the smallest gain at which the first target would cover its costs */
  breakEvenGainPct: number;
  pays: boolean;
}

export function scalpEconomics(p: { amountUsd: number; firstTargetGainPct: number; firstTargetSellPct: number; quote: ScalpQuoteCosts }): ScalpEconomics {
  const sold = p.amountUsd * (Math.min(100, Math.max(0, p.firstTargetSellPct)) / 100);
  const feeEachWay = p.quote.networkFeeUsd + p.quote.priorityFeeUsd + p.quote.platformFeeUsd;
  const impactUsd = sold * (Math.max(0, p.quote.priceImpactPct) / 100) * 2; // in and out, on the part that is sold
  const cost = 2 * feeEachWay + impactUsd;
  const profit = sold * (p.firstTargetGainPct / 100);
  return { firstTargetProfitUsd: profit, roundTripCostUsd: cost, netUsd: profit - cost, breakEvenGainPct: sold > 0 ? (cost / sold) * 100 : Infinity, pays: profit > cost };
}
