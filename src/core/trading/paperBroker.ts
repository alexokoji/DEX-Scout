import { FEES } from "../config";
import { CHAINS } from "../chains";
import type { ChainId } from "../types";
import { constantProductImpactPct } from "./quoteMath";

export interface PaperFillInput {
  chain?: ChainId;
  side: "BUY" | "SELL";
  /** USD notional for buys; for sells the USD value of tokens at the mid price */
  amountUsd: number;
  midPriceUsd: number;
  liquidityUsd: number;
  slippageBps: number;
  priorityFeeNative?: number;
  /** false when the pool is inactive / sell simulation fails */
  tradeable: boolean;
  rng?: () => number;
  /** probability of a simulated network failure (default 1.5%) */
  failureRate?: number;
}

export type PaperFill =
  | {
      ok: true;
      fillPriceUsd: number;
      tokenAmount: number;
      /** USD paid for a buy, USD received (net of fees) for a sell */
      usd: number;
      feesUsd: number;
      networkFeeUsd: number;
      priceImpactPct: number;
      /** realised adverse slippage on top of impact, percent */
      slippagePct: number;
    }
  | { ok: false; reason: string };

/**
 * Simulated fill for PAPER mode: applies price impact from pool depth, random adverse slippage (bounded by the
 * user's tolerance), swap fees, network + priority fees, and occasional transaction failures.
 * Nothing here touches a chain; results are recorded as PAPER trades without a transaction signature.
 */
export function simulateFill(i: PaperFillInput): PaperFill {
  const rng = i.rng ?? Math.random;
  if (!i.tradeable) return { ok: false, reason: "Token is not tradeable (pool inactive or sell simulation failed)" };
  if (i.liquidityUsd < 500) return { ok: false, reason: "Liquidity unavailable" };
  if (rng() < (i.failureRate ?? 0.015)) return { ok: false, reason: "Simulated transaction failure (network congestion)" };

  const impact = constantProductImpactPct(i.amountUsd, i.liquidityUsd);
  const maxSlip = i.slippageBps / 100; // percent
  // adverse random slippage up to ~40% of tolerance, plus impact
  const slippagePct = rng() * maxSlip * 0.4;
  const totalAdverse = impact + slippagePct;
  if (totalAdverse > maxSlip + 1e-9 && impact > maxSlip) {
    return { ok: false, reason: `Slippage exceeded: price impact ${impact.toFixed(2)}% > tolerance ${maxSlip.toFixed(2)}%` };
  }

  const feesUsd = (i.amountUsd * FEES.swapFeeBps) / 10_000;
  const meta = CHAINS[i.chain ?? "solana"];
  const networkFeeUsd = meta.typicalFeeUsd + (i.priorityFeeNative ?? 0) * meta.mockNativeUsd;

  if (i.side === "BUY") {
    const fillPrice = i.midPriceUsd * (1 + totalAdverse / 100);
    const tokenAmount = (i.amountUsd - feesUsd) / fillPrice;
    return { ok: true, fillPriceUsd: fillPrice, tokenAmount, usd: i.amountUsd + networkFeeUsd, feesUsd, networkFeeUsd, priceImpactPct: impact, slippagePct };
  }
  const fillPrice = i.midPriceUsd * (1 - totalAdverse / 100);
  const tokenAmount = i.amountUsd / i.midPriceUsd;
  const gross = tokenAmount * fillPrice;
  const sellFees = (gross * FEES.swapFeeBps) / 10_000;
  return { ok: true, fillPriceUsd: fillPrice, tokenAmount, usd: gross - sellFees - networkFeeUsd, feesUsd: sellFees, networkFeeUsd, priceImpactPct: impact, slippagePct };
}
