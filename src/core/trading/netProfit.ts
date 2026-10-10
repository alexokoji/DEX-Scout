/**
 * Is a sale still a profit after every network fee it took to get here? A target reached on price isn't a win if the fee to buy and the fee
 * to sell are more than the gain. This takes what the sale would bring in, what the sold tokens cost, the fee the sale itself will cost
 * (from the chain's quote for it) and the buy's fee that was actually paid (read from the confirmed buy), and says what is left.
 */
export interface NetAfterFees {
  /** what is left after the tokens' cost and both fees (negative = a loss) */
  netUsd: number;
  costUsd: number;
  /** the part of the buy fee that belongs to the tokens being sold */
  buyFeeShareUsd: number;
  sellFeeUsd: number;
  pays: boolean;
}

export function netAfterFees(p: { soldTokens: number; entryPriceUsd: number; proceedsUsd: number; sellFeeUsd: number; buyFeesUsd: number; initialAmount: number }): NetAfterFees {
  const cost = p.soldTokens * p.entryPriceUsd;
  // the buy fee was paid once, for all the tokens: a sale of part of them carries that part of it
  const share = p.initialAmount > 0 ? p.buyFeesUsd * Math.min(1, p.soldTokens / p.initialAmount) : p.buyFeesUsd;
  const net = p.proceedsUsd - cost - p.sellFeeUsd - share;
  return { netUsd: net, costUsd: cost, buyFeeShareUsd: share, sellFeeUsd: p.sellFeeUsd, pays: net > 0 };
}
