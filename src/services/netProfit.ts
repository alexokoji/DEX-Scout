import { netAfterFees, type NetAfterFees } from "@/core/trading/netProfit";
import { providers } from "@/core/providers/registry";
import type { ChainId } from "@/core/types";
import { collections, newId } from "@/lib/db";
import type { PositionDoc } from "@/lib/models";
import { getSettings } from "./settings";

/** What was really paid in fees to buy a position: read from its confirmed buys (the wallet's own record of the fee), else the quote's figure. */
export async function buyFeesPaid(positionId: string): Promise<number> {
  const buys = await (await collections.trades()).find({ positionId, side: "BUY", status: "CONFIRMED" }, { projection: { walletChange: 1, networkFeeUsd: 1, feesUsd: 1 } }).toArray();
  return buys.reduce((s, t) => s + (t.walletChange ? t.walletChange.feeNative * t.walletChange.nativeUsd : t.networkFeeUsd + t.feesUsd), 0);
}

export interface SellNetCheck extends NetAfterFees {
  /** what the sale would bring in, from the chain's quote for selling exactly this amount now */
  proceedsUsd: number;
  /** false when the quote couldn't give the sell fee, so the fee paid to buy stood in for it */
  sellFeeKnown: boolean;
}

/**
 * Would selling `amount` of this position now still be a profit after the fee paid to buy it and the fee to sell it? Asks the chain for a
 * quote of this very sale (what it would pay out, what it would cost to send) and sets it against what the tokens cost and the buy's fee
 * that was actually paid. null = the sale couldn't be priced right now.
 */
export async function checkSellNet(userId: string, pos: PositionDoc, amount: number): Promise<SellNetCheck | null> {
  const token = await (await collections.tokens()).findOne({ _id: pos.tokenId });
  if (!token || !pos.walletAddress) return null;
  const settings = await getSettings(userId);
  const quote = await providers().dex.getQuote({ chain: token.chain as ChainId, side: "SELL", tokenAddress: token.address, amountUsd: amount * token.priceUsd, tokenAmount: amount, slippageBps: settings.maxSlippageBps, wallet: pos.walletAddress }).catch(() => null);
  if (!quote) return null;
  const buyFees = await buyFeesPaid(pos._id);
  const sellFeeKnown = quote.networkFeeKnown !== false;
  const sellFeeUsd = sellFeeKnown ? quote.networkFeeUsd + quote.priorityFeeUsd + quote.platformFeeUsd : buyFees; // an unreadable sell fee is taken to be like the buy's
  const net = netAfterFees({ soldTokens: amount, entryPriceUsd: pos.entryPriceUsd, proceedsUsd: quote.outputAmount, sellFeeUsd, buyFeesUsd: buyFees, initialAmount: pos.initialAmount });
  return { ...net, proceedsUsd: quote.outputAmount, sellFeeKnown };
}

/** Say on the position why a reached target isn't being sold yet (at most once in a while, so a wait that lasts doesn't fill its history). */
export async function noteFeesWait(pos: PositionDoc, reason: string, check: SellNetCheck | null): Promise<void> {
  const events = await collections.positionEvents();
  if (await events.findOne({ positionId: pos._id, type: "FEES_WAIT", createdAt: { $gt: new Date(Date.now() - 30 * 60_000) } }, { projection: { _id: 1 } })) return;
  const d = (n: number) => `$${n.toFixed(Math.abs(n) < 1 ? 4 : 2)}`;
  const message = check
    ? `${reason}, but selling now would leave ${d(check.netUsd)} after fees (the tokens cost ${d(check.costUsd)}, the sale brings ${d(check.proceedsUsd)}, minus ${d(check.sellFeeUsd)} to sell and ${d(check.buyFeeShareUsd)} of the buy fee): waiting for a higher price.`
    : `${reason}, but the sale couldn't be priced right now, so it can't be checked against the fees: waiting.`;
  await events.insertOne({ _id: newId(), positionId: pos._id, type: "FEES_WAIT", message, data: check ? { netUsd: check.netUsd, sellFeeUsd: check.sellFeeUsd, buyFeeShareUsd: check.buyFeeShareUsd } : null, createdAt: new Date() });
}
