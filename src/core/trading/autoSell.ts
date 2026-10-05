import type { ProfitTargetConfig } from "../types";
import { evaluateTargets, normalizeTargets, type PositionState } from "./targets";

/**
 * Auto-sell: instead of waiting for the user to sign a sell when a profit target is hit, the app prepares one limit sell
 * per target the moment a position opens. The user signs them once; a keeper network then fills each on-chain when its
 * price is reached, even while the user is away. Nothing here signs or sends anything.
 */

export interface PlannedOrder {
  /** the target levels this order covers (several when small targets had to be merged) */
  levels: number[];
  /** the lowest covered target's gain: the order fires as soon as that price is available */
  gainPct: number;
  targetPriceUsd: number;
  /** tokens to sell */
  tokenAmount: number;
}

/** One limit sell per remaining target, using exactly the amounts the manual target logic would sell. */
export function planAutoSells(pos: PositionState, targets: ProfitTargetConfig[]): PlannedOrder[] {
  const sorted = normalizeTargets(targets);
  if (!sorted.length || pos.amount <= 0 || !(pos.entryPriceUsd > 0)) return [];
  const topGain = sorted[sorted.length - 1].gainPct;
  // a price above every target makes evaluateTargets return all the remaining sells, in order
  const actions = evaluateTargets(pos, pos.entryPriceUsd * (1 + topGain / 100) * 1.01, sorted);
  return actions
    .filter((a) => a.sellAmount > 0)
    .map((a) => ({ levels: [a.level], gainPct: a.gainPct, targetPriceUsd: pos.entryPriceUsd * (1 + a.gainPct / 100), tokenAmount: a.sellAmount }));
}

/**
 * Venues with a minimum order size (Jupiter: about $5) can't take a tiny slice. Merge a slice that is too small with the
 * NEXT target, and sell the merged amount at the EARLIER target's price (locking the profit in sooner rather than later).
 * Whatever is left over at the end that is still too small joins the previous order. Total tokens are always preserved.
 */
export function mergeForMinimum(orders: PlannedOrder[], currentPriceUsd: number, minUsd: number): PlannedOrder[] {
  const out: PlannedOrder[] = [];
  let carry: PlannedOrder | null = null;
  const big = (o: PlannedOrder) => o.tokenAmount * currentPriceUsd >= minUsd;
  for (const o of orders) {
    const cur: PlannedOrder = carry
      ? { levels: [...carry.levels, ...o.levels], gainPct: carry.gainPct, targetPriceUsd: carry.targetPriceUsd, tokenAmount: carry.tokenAmount + o.tokenAmount }
      : { ...o, levels: [...o.levels] };
    carry = null;
    if (big(cur)) out.push(cur);
    else carry = cur;
  }
  if (carry) {
    const last = out[out.length - 1];
    if (last) out[out.length - 1] = { ...last, levels: [...last.levels, ...carry.levels], tokenAmount: last.tokenAmount + carry.tokenAmount };
    else if (big(carry)) out.push(carry);
    // the whole position is below the minimum: no order is possible
  }
  return out;
}

/** Raw (integer) amount from a human number, without float drift for large decimals. */
export function toRaw(amount: number, decimals: number): bigint {
  if (!Number.isFinite(amount) || amount <= 0) return BigInt(0);
  // the shortest decimal string for the number ("0.009"), not its binary expansion ("0.00899999…"); exponent forms fall back to toFixed
  let s = String(amount);
  if (/e/i.test(s)) s = amount.toFixed(Math.min(decimals, 18));
  const [i, f = ""] = s.split(".");
  return BigInt(i + f.padEnd(decimals, "0").slice(0, decimals));
}

/**
 * Smallest amount of the native/output currency (raw, 18 or 9 decimals) the order will accept: the tokens sold at the
 * target price, grossed up for a known venue fee so the user nets the target. A venue with no fee passes 0.
 */
export function minProceedsRaw(tokenAmount: number, targetPriceUsd: number, nativeUsd: number, nativeDecimals: number, venueFeeFraction = 0): bigint {
  if (!(nativeUsd > 0) || !(targetPriceUsd > 0)) return BigInt(0);
  const native = (tokenAmount * targetPriceUsd) / nativeUsd / (1 - Math.min(0.5, Math.max(0, venueFeeFraction)));
  // 12 significant digits: removes float noise (0.009 coming out as 0.00899999…) without changing the price in any way that matters
  return toRaw(Number(native.toPrecision(12)), nativeDecimals);
}

/** What one sync of a venue order adds to the books: only the part not already booked. */
export function fillDelta(prev: { sellRaw: bigint; buyRaw: bigint }, now: { sellRaw: bigint; buyRaw: bigint }): { sellRaw: bigint; buyRaw: bigint } | null {
  const sell = now.sellRaw - prev.sellRaw;
  if (sell <= BigInt(0)) return null;
  const buy = now.buyRaw - prev.buyRaw;
  return { sellRaw: sell, buyRaw: buy > BigInt(0) ? buy : BigInt(0) };
}
