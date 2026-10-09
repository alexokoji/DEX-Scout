import { toRaw } from "./autoSell";

/**
 * The largest error a position's token amount can carry. A position's amount is a number built from the chain's integer balance
 * (a double holds about 16 significant digits, so a token with 18 decimals can't be held exactly): turned back into whole units it can
 * come out a few units above what the wallet really holds, which a token contract refuses ("transfer amount exceeds balance"), and a
 * wallet shows as "insufficient balance". This is the double's own precision, not a chosen margin.
 */
const FLOAT_NOISE = 1e-12;

/**
 * How many raw units to sell. Never more than the wallet holds: when the request is the whole position (or within float noise of the
 * whole balance) it is exactly the balance, so a full sale takes everything and can't be a few units too large. With no balance
 * to check against (it couldn't be read), the amount asked for.
 */
export function sellRaw(tokenAmount: number, decimals: number, balanceRaw: bigint | null): bigint {
  const want = toRaw(tokenAmount, decimals);
  if (balanceRaw === null) return want;
  if (want >= balanceRaw) return balanceRaw;
  if (Number(balanceRaw - want) <= Number(balanceRaw) * FLOAT_NOISE) return balanceRaw;
  return want;
}
