import { FEES } from "../config";
import { CHAINS, NATIVE_EVM } from "../chains";
import type { ChainId, DataSourceKind, SwapQuote } from "../types";

/**
 * Price impact (percent) of swapping `amountUsd` into a constant-product pool whose total liquidity is
 * `liquidityUsd` (both sides). Approximation used by the mock DEX and paper broker.
 */
export function constantProductImpactPct(amountUsd: number, liquidityUsd: number): number {
  if (liquidityUsd <= 0) return 100;
  const side = liquidityUsd / 2;
  return (amountUsd / (side + amountUsd)) * 100;
}

export function quoteFromImpact(p: {
  chain: ChainId;
  side: "BUY" | "SELL";
  tokenAddress: string;
  priceUsd: number;
  amountUsd: number;
  impactPct: number;
  slippageBps: number;
  /** priority/gas tip in the chain's native unit */
  priorityFeeNative: number;
  route: string[];
  source: DataSourceKind;
}): SwapQuote {
  const meta = CHAINS[p.chain];
  const native = meta.family === "evm" ? NATIVE_EVM : meta.nativeSymbol;
  const feeUsd = (p.amountUsd * FEES.swapFeeBps) / 10_000;
  const effectivePrice = p.side === "BUY" ? p.priceUsd * (1 + p.impactPct / 100) : p.priceUsd * (1 - p.impactPct / 100);
  const netUsd = p.amountUsd - feeUsd;
  const outputAmount = p.side === "BUY" ? netUsd / effectivePrice : netUsd * (1 - p.impactPct / 100);
  const minReceived = outputAmount * (1 - p.slippageBps / 10_000);
  return {
    chain: p.chain,
    inputMint: p.side === "BUY" ? native : p.tokenAddress,
    outputMint: p.side === "BUY" ? p.tokenAddress : native,
    inputAmountUsd: p.amountUsd,
    outputAmount,
    effectivePriceUsd: effectivePrice,
    priceImpactPct: p.impactPct,
    slippageBps: p.slippageBps,
    minReceived,
    networkFeeUsd: meta.typicalFeeUsd,
    priorityFeeUsd: p.priorityFeeNative * meta.mockNativeUsd,
    platformFeeUsd: feeUsd,
    route: p.route,
    expiresAt: new Date(Date.now() + 30_000),
    source: p.source,
  };
}
