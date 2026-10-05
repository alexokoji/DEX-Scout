import type { NotificationType, TradeKind } from "@/lib/models";

/**
 * What each notification says. Pure functions so the wording is easy to test; delivery lives in notifications.ts.
 * Titles stay plain ASCII (they go in an HTTP header for ntfy).
 */

export type NotificationCategory = "approvals" | "results" | "positions" | "system";
export const NOTIFICATION_CATEGORIES: readonly NotificationCategory[] = ["approvals", "results", "positions", "system"];

/** Which switch in Settings -> Notifications controls each type. */
export const CATEGORY_OF: Record<NotificationType, NotificationCategory> = {
  BUY_QUEUED: "approvals",
  SELL_QUEUED: "approvals",
  TRADE_EXPIRED: "approvals",
  AUTOSELL_SUGGESTED: "approvals",
  AUTOSELL_PROBLEM: "approvals",
  PROFIT_TAKEN: "results",
  TRADE_CONFIRMED: "results",
  TRADE_FAILED: "results",
  POSITION_ALERT: "positions",
  SYSTEM_ALERT: "system",
};

export interface Message {
  type: NotificationType;
  title: string;
  body: string;
  url: string;
  tradeId?: string | null;
  dedupeKey?: string;
  remindAfterMin?: number;
  priority?: "urgent" | "high" | "default";
}

const money = (n: number) => `${n < 0 ? "-" : ""}$${Math.abs(n).toFixed(2)}`;
const signed = (n: number) => `${n >= 0 ? "+" : "-"}$${Math.abs(n).toFixed(2)}`;

export function sellQueued(kind: TradeKind, symbol: string, chainName: string, reason: string, fraction: number, usdValue: number, tradeId: string, positionId = ""): Message {
  const pct = Math.round(Math.min(1, Math.max(0, fraction)) * 100);
  const emergency = kind === "EMERGENCY_EXIT";
  return {
    type: "SELL_QUEUED",
    title: emergency ? `Emergency exit ready: ${symbol}` : kind === "TARGET_EXIT" ? `Target hit: ${symbol} sell ready to sign` : `Sell ready to sign: ${symbol}`,
    body: `${reason}. Sell ${pct}% (~${money(usdValue)}) on ${chainName}. Open DEX Scout and approve it in your wallet within 10 minutes.`,
    url: "/wallet",
    tradeId,
    dedupeKey: `sell:${positionId}:${kind}`,
    priority: emergency ? "urgent" : "high",
  };
}

export function buyQueued(symbol: string, chainName: string, amountUsd: number, impactPct: number, tradeId: string, tokenId: string): Message {
  return {
    type: "BUY_QUEUED",
    title: `Buy ready to sign: ${symbol}`,
    body: `The bot wants to buy ${money(amountUsd)} of ${symbol} on ${chainName} (price impact ${impactPct.toFixed(2)}%). Open DEX Scout and approve it in your wallet within 15 minutes; it is re-priced when you do, and refused if the price has run away.`,
    url: "/wallet",
    tradeId,
    dedupeKey: `buy:${tokenId}`,
    remindAfterMin: 30,
    priority: "high",
  };
}

export function tradeExpired(kind: TradeKind, side: "BUY" | "SELL", symbol: string, tradeId: string): Message {
  const what = side === "BUY" ? "buy" : kind === "EMERGENCY_EXIT" ? "emergency exit" : kind === "TARGET_EXIT" ? "target sell" : "sell";
  return {
    type: "TRADE_EXPIRED",
    title: `Missed: ${symbol} ${what} expired`,
    body: side === "SELL"
      ? `The ${what} for ${symbol} expired unsigned, so nothing was sold. A fresh one is queued automatically while the target still applies.`
      : `The bot's ${what} for ${symbol} expired unsigned, so nothing was bought. The bot may queue it again if the signal still qualifies.`,
    url: "/wallet",
    tradeId,
    dedupeKey: `expired:${tradeId}`,
    priority: kind === "EMERGENCY_EXIT" ? "urgent" : "default",
  };
}

export function tradeConfirmed(args: { side: "BUY" | "SELL"; symbol: string; chainName: string; usd: number; tokens: number; tradeId: string; realizedDeltaUsd?: number; closed?: boolean; totalPnlUsd?: number; totalPnlPct?: number }): Message {
  const { side, symbol, chainName, usd, tokens, tradeId } = args;
  const amount = tokens >= 1 ? tokens.toLocaleString("en-US", { maximumFractionDigits: 2 }) : tokens.toPrecision(3);
  if (side === "BUY") {
    return { type: "TRADE_CONFIRMED", title: `Bought ${symbol}`, body: `Confirmed on ${chainName}: ${amount} ${symbol} for about ${money(usd)}. Position open; profit targets are active.`, url: "/positions", tradeId, dedupeKey: `confirmed:${tradeId}` };
  }
  if (args.realizedDeltaUsd !== undefined) return profitTaken({ symbol, chainName, tokens, proceedsUsd: usd, realizedDeltaUsd: args.realizedDeltaUsd, closed: !!args.closed, tradeId, totalPnlUsd: args.totalPnlUsd, totalPnlPct: args.totalPnlPct });
  return { type: "TRADE_CONFIRMED", title: args.closed ? `Sold ${symbol} - position closed` : `Sold part of ${symbol}`, body: `Confirmed on ${chainName}: sold ${amount} ${symbol} for about ${money(usd)}.${args.closed ? " Position closed." : " The rest stays open."}`, url: "/positions", tradeId, dedupeKey: `confirmed:${tradeId}` };
}

/** Percent return on the part that was sold: profit / what that part cost. */
export function profitPct(proceedsUsd: number, realizedDeltaUsd: number): number {
  const cost = proceedsUsd - realizedDeltaUsd;
  return cost > 0 ? (realizedDeltaUsd / cost) * 100 : 0;
}

/** A sell settled (signed by you, or filled by an auto-sell order): how much was made, in dollars and percent. */
export function profitTaken(args: { symbol: string; chainName: string; tokens: number; proceedsUsd: number; realizedDeltaUsd: number; closed: boolean; tradeId: string; auto?: boolean; totalPnlUsd?: number; totalPnlPct?: number }): Message {
  const pct = profitPct(args.proceedsUsd, args.realizedDeltaUsd);
  const win = args.realizedDeltaUsd >= 0;
  const amount = args.tokens >= 1 ? args.tokens.toLocaleString("en-US", { maximumFractionDigits: 2 }) : args.tokens.toPrecision(3);
  const total = args.closed && args.totalPnlUsd !== undefined && args.totalPnlPct !== undefined ? ` Position closed: ${args.totalPnlPct >= 0 ? "+" : ""}${args.totalPnlPct.toFixed(1)}% overall (${signed(args.totalPnlUsd)}).` : args.closed ? " Position closed." : " The rest stays open.";
  return {
    type: "PROFIT_TAKEN",
    title: win ? `Profit taken: ${args.symbol} ${pct >= 0 ? "+" : ""}${pct.toFixed(1)}%` : `Sold ${args.symbol} at a loss: ${pct.toFixed(1)}%`,
    body: `${args.auto ? "Your auto-sell order filled. " : ""}Sold ${amount} ${args.symbol} on ${args.chainName} for about ${money(args.proceedsUsd)}: ${win ? "profit" : "loss"} ${signed(args.realizedDeltaUsd)} (${pct >= 0 ? "+" : ""}${pct.toFixed(1)}% on that portion).${total}`,
    url: "/positions",
    tradeId: args.tradeId,
    dedupeKey: `confirmed:${args.tradeId}`,
    priority: "high",
  };
}

/** The bot has prepared sell orders for a position that was just bought; one wallet approval arms them all. */
export function autoSellSuggested(symbol: string, chainName: string, orders: { gainPct: number; sellPct: number }[], positionId: string): Message {
  const steps = orders.map((o) => `${Math.round(o.sellPct)}% at +${o.gainPct}%`).join(", ");
  return {
    type: "AUTOSELL_SUGGESTED",
    title: `Arm auto-sell for ${symbol}`,
    body: `You bought ${symbol} on ${chainName}. Suggested sell orders: ${steps}. Approve them once in your wallet (Positions page) and they sell automatically when each price is reached, even if you're away. Until then nothing sells by itself.`,
    url: "/positions",
    dedupeKey: `autosell-suggest:${positionId}`,
    remindAfterMin: 360,
    priority: "high",
  };
}

export function autoSellProblem(kind: "expired" | "failed" | "cancelled", symbol: string, detail: string, positionId: string): Message {
  const what = kind === "expired" ? "expired" : kind === "cancelled" ? "was cancelled" : "could not be placed";
  return {
    type: "AUTOSELL_PROBLEM",
    title: `Auto-sell ${what}: ${symbol}`,
    body: `${detail.slice(0, 220)}${kind === "cancelled" ? "" : " Open Positions to arm it again so the targets keep protecting your profit."}`,
    url: "/positions",
    dedupeKey: `autosell-${kind}:${positionId}`,
    remindAfterMin: 180,
    priority: "high",
  };
}

export function tradeFailed(side: "BUY" | "SELL", symbol: string, reason: string, tradeId: string): Message {
  return {
    type: "TRADE_FAILED",
    title: `${side === "BUY" ? "Buy" : "Sell"} failed: ${symbol}`,
    body: `${reason.slice(0, 200)}. Nothing was ${side === "BUY" ? "bought" : "sold"} in the app's books. Check your wallet's activity before retrying.`,
    url: "/trades",
    tradeId,
    dedupeKey: `failed:${tradeId}`,
    priority: "high",
  };
}

export function positionAlert(health: "WARNING" | "EMERGENCY", symbol: string, why: string, positionId: string): Message {
  const emergency = health === "EMERGENCY";
  return {
    type: "POSITION_ALERT",
    title: emergency ? `Emergency: ${symbol} position at risk` : `Warning: ${symbol} position`,
    body: `${why.slice(0, 220)}.${emergency ? " Consider selling now." : ""}`,
    url: "/positions",
    dedupeKey: `health:${positionId}:${health}`,
    remindAfterMin: emergency ? 120 : 360,
    priority: emergency ? "urgent" : "default",
  };
}

export function scannerOffline(minutes: number): Message {
  return {
    type: "SYSTEM_ALERT",
    title: "Scanner is not running",
    body: `No scan has completed for ${Math.round(minutes)} minutes. Prices and signals are going stale and the bot cannot find new entries. Check that the scan cron job is still calling /api/cron/scan.`,
    url: "/",
    dedupeKey: "system:scanner-offline",
    remindAfterMin: 180,
    priority: "high",
  };
}
