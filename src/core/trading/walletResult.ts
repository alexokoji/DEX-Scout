/**
 * What the wallet itself did, as opposed to what the token's price did. A position's profit and loss is measured on the swap (price in,
 * price out). The wallet's own balance also moves by the network fees and, on Solana, by the deposit a token account locks the first
 * time a token is held (returned only when the empty account is closed). This puts those next to the price figure so the two can be
 * reconciled with what the wallet shows, using only what each confirmed transaction reported.
 */
export interface WalletChange {
  /** the change in the wallet's native balance (SOL/ETH...), fee and any deposit included; negative = it left the wallet */
  nativeDelta: number;
  feeNative: number;
  /** native coin locked into token accounts this transaction opened (positive) or returned from ones it closed (negative) */
  depositNative: number;
  /** the native coin's price in USD when it confirmed */
  nativeUsd: number;
}

export interface WalletResult {
  /** what the wallet gained or lost in total over this position's transactions, deposits and fees included, plus any deposit since reclaimed */
  changeUsd: number;
  feesUsd: number;
  /** the deposit still held in the token account: returned when the empty account is closed */
  depositHeldUsd: number;
  /** the swaps alone: what was paid for the token against what was received for it, with fees and the deposit taken out */
  swapNetUsd: number;
}

/** null when any transaction of the position wasn't read from the chain (older trades, or sales a venue filled): a partial sum would mislead. */
export function walletResult(trades: { walletChange?: WalletChange | null }[], reclaimedUsd = 0): WalletResult | null {
  if (!trades.length || trades.some((t) => !t.walletChange)) return null;
  let change = 0;
  let fees = 0;
  let deposit = 0;
  for (const t of trades) {
    const w = t.walletChange!;
    change += w.nativeDelta * w.nativeUsd;
    fees += w.feeNative * w.nativeUsd;
    deposit += w.depositNative * w.nativeUsd;
  }
  change += reclaimedUsd;
  const held = Math.max(0, deposit - reclaimedUsd);
  return { changeUsd: change, feesUsd: fees, depositHeldUsd: held, swapNetUsd: change + fees + held };
}
