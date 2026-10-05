/**
 * Solana swap costs, derived from what the chain reports rather than numbers we picked:
 *  - the base fee per signature (getFeeForMessage),
 *  - the going priority fee (getRecentPrioritizationFees, in micro-lamports per compute unit),
 *  - the deposit for a new token account (getMinimumBalanceForRentExemption(165)). That figure changed on mainnet (it is now
 *    1,488,440 lamports, not the 2,039,280 remembered from older docs), which is exactly why it must not be hard-coded.
 */

/** The minimal slice of @solana/web3.js's Connection that fee estimation needs (so it can be tested without a network). */
export interface FeeConnection {
  getMinimumBalanceForRentExemption(dataLength: number): Promise<number>;
  getRecentPrioritizationFees(): Promise<{ prioritizationFee: number }[]>;
  /** lamports for a one-signature message */
  baseFeePerSignature(): Promise<number>;
}

/** An SPL token account's data size in bytes (the account the swap opens to hold the bought token). */
export const TOKEN_ACCOUNT_BYTES = 165;
/** A swap's compute budget used to turn "micro-lamports per compute unit" into a fee. Jupiter sizes the real limit by simulation (typically 120-250k). */
export const SWAP_COMPUTE_UNITS = 300_000;
/** Never let an automatic priority fee exceed this (0.002 SOL) however busy the network, unless the user sets a higher cap. */
export const MAX_AUTO_PRIORITY_LAMPORTS = 2_000_000;

export function percentile(values: number[], q: number): number {
  if (!values.length) return 0;
  const s = [...values].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.floor(s.length * q)))];
}

/** Priority fee in lamports for a swap: the 75th percentile of recent per-slot fees, capped. 0 when the network isn't charging any. */
export function priorityLamports(recentMicroLamportsPerCu: number[], capLamports = MAX_AUTO_PRIORITY_LAMPORTS): number {
  const microPerCu = percentile(recentMicroLamportsPerCu, 0.75);
  const lamports = Math.ceil((microPerCu * SWAP_COMPUTE_UNITS) / 1_000_000);
  return Math.max(0, Math.min(lamports, capLamports));
}

export interface SolanaCosts {
  baseFeeLamports: number;
  priorityFeeLamports: number;
  /** rent-exempt deposit for one token account */
  rentLamports: number;
}

export async function readSolanaCosts(c: FeeConnection, capLamports?: number): Promise<SolanaCosts> {
  const [rent, fees, base] = await Promise.all([c.getMinimumBalanceForRentExemption(TOKEN_ACCOUNT_BYTES), c.getRecentPrioritizationFees(), c.baseFeePerSignature()]);
  return { baseFeeLamports: base, priorityFeeLamports: priorityLamports(fees.map((f) => f.prioritizationFee), capLamports), rentLamports: rent };
}

/**
 * The most SOL a buy needs on top of the amount swapped, at the instant it runs: the fees, the deposit for a new token
 * account unless the wallet already has one for this token, and the temporary wrapped-SOL account the swap opens (same
 * deposit, returned within the same transaction but it has to be affordable at that moment).
 */
export function swapReserveLamports(costs: SolanaCosts, walletHasTokenAccount: boolean | null): { peakLamports: number; netLamports: number; needsTokenAccount: boolean } {
  const needsTokenAccount = walletHasTokenAccount !== true; // unknown counts as "needs one": the safe side
  const peak = costs.baseFeeLamports + costs.priorityFeeLamports + costs.rentLamports * (needsTokenAccount ? 2 : 1);
  const net = costs.baseFeeLamports + costs.priorityFeeLamports + (needsTokenAccount ? costs.rentLamports : 0);
  return { peakLamports: peak, netLamports: net, needsTokenAccount };
}
