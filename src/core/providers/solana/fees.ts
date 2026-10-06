/**
 * Solana swap fees, read from the chain at the moment they are needed:
 *  - the base fee per signature (getFeeForMessage),
 *  - the going priority price in the fee market of the pools being traded (getRecentPrioritizationFees, micro-lamports per
 *    compute unit), which becomes a fee when multiplied by the compute units the swap will actually use. Jupiter sizes those
 *    itself by simulating the exact route and wallet (the `computeUnitLimit` of its swap response), so the number of units is
 *    never assumed here.
 * Whether the wallet can afford a swap is not estimated at all: the built transaction is simulated by the chain (see
 * JupiterDexAdapter.preflight), which answers with the exact balance and the exact need.
 */

/** The minimal slice of @solana/web3.js's Connection that fee reading needs (so it can be tested without a network). */
export interface FeeConnection {
  getRecentPrioritizationFees(): Promise<{ prioritizationFee: number }[]>;
  /** lamports for a one-signature message */
  baseFeePerSignature(): Promise<number>;
}

/**
 * How high in the fee market a swap bids. The fee market is per ACCOUNT (the pools being traded), not network-wide: measured
 * live, the network-wide figure was 0 while the pools of active tokens showed p75 = 50,000-75,000 and p90 = 500,000-800,000
 * micro-lamports/CU. A swap that bids 0 there lands behind everyone else, and on a fast-moving token those extra seconds are
 * what pushes the price past the slippage limit (error 6001). This is a bidding policy, not a fee: the chain can tell what
 * others pay, but not how much of a rush to be in. The 90th percentile is what Jupiter calls its "high" tier.
 */
export const LANDING_QUANTILE = 0.9;

export function percentile(values: number[], q: number): number {
  if (!values.length) return 0;
  const s = [...values].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.floor(s.length * q)))];
}

/** The going price per compute unit (micro-lamports) at the bidding level, from the fees recently paid. 0 when nobody is paying any. */
export function priorityMicroLamportsPerCu(recentMicroLamportsPerCu: number[], quantile = LANDING_QUANTILE): number {
  return percentile(recentMicroLamportsPerCu, quantile);
}

/**
 * The fee that price comes to for a swap using `computeUnits`, in lamports. `capLamports` is the user's own limit (Settings or the
 * trade panel); there is no built-in one. Rounded up so the price is never undercut.
 */
export function priorityLamports(microLamportsPerCu: number, computeUnits: number, capLamports?: number): number {
  const lamports = Math.ceil((microLamportsPerCu * computeUnits) / 1_000_000);
  return Math.max(0, capLamports === undefined ? lamports : Math.min(lamports, capLamports));
}

/** The price per compute unit that makes `computeUnits` cost no more than the user's cap (their limit holds whatever the market does). */
export function capMicroLamportsPerCu(microLamportsPerCu: number, computeUnits: number, capLamports?: number): number {
  if (capLamports === undefined || !(computeUnits > 0)) return microLamportsPerCu;
  return Math.min(microLamportsPerCu, (capLamports * 1_000_000) / computeUnits);
}

export interface SolanaCosts {
  baseFeeLamports: number;
  /** going price per compute unit at the bidding level, network-wide (the pools' own market is read per route) */
  microLamportsPerCu: number;
}

export async function readSolanaCosts(c: FeeConnection): Promise<SolanaCosts> {
  const [fees, base] = await Promise.all([c.getRecentPrioritizationFees(), c.baseFeePerSignature()]);
  return { baseFeeLamports: base, microLamportsPerCu: priorityMicroLamportsPerCu(fees.map((f) => f.prioritizationFee)) };
}
