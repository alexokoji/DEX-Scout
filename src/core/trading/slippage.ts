/**
 * A slippage setting that suits how fast a token is moving right now. A swap is priced when it is built and settles some
 * seconds later; on a token moving several percent a minute, a 1-3% tolerance is spent before it lands and the chain cancels
 * the swap (Jupiter error 6001) at the cost of the network fee. Faster tokens need more room; calm ones don't.
 * Never exceeds the user's own maximum, and says when it was held back by it.
 */
export const SLIPPAGE_STEPS_BPS = [300, 500, 1000, 2000] as const;

export interface SlippageSuggestion {
  bps: number;
  /** what the volatility alone called for, if the user's maximum held it back */
  wantedBps: number;
  cappedByMax: boolean;
  /** the move this was based on, in % */
  movePct: number;
}

export function suggestSlippage(change5mPct: number, change1hPct: number, maxBps: number): SlippageSuggestion {
  // the 5-minute move is the best read of "right now"; a quarter of the hour's move catches a token that has been running
  const movePct = Math.max(Math.abs(change5mPct) || 0, Math.abs(change1hPct) / 4 || 0);
  const wantedBps = movePct < 3 ? SLIPPAGE_STEPS_BPS[0] : movePct < 8 ? SLIPPAGE_STEPS_BPS[1] : movePct < 20 ? SLIPPAGE_STEPS_BPS[2] : SLIPPAGE_STEPS_BPS[3];
  const bps = Math.max(1, Math.min(wantedBps, maxBps));
  return { bps, wantedBps, cappedByMax: wantedBps > maxBps, movePct };
}
