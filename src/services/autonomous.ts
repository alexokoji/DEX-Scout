import { sendEvmRaw, signEvmCall, waitForEvmReceipt } from "@/core/providers/evm/botSigner";
import { signSolanaTransaction } from "@/core/providers/solana/botSigner";
import { providers } from "@/core/providers/registry";
import { dayStart, evaluateDay, type DayEvent, type GovernorDecision } from "@/core/trading/governor";
import type { ChainId } from "@/core/types";
import { collections } from "@/lib/db";
import { logEvent, safeMessage } from "@/lib/events";
import type { PositionDoc, TradeDoc, TradeKind } from "@/lib/models";
import { botEvmAccount, botSolanaKeypair, botWalletsConfigured, getBotWallet } from "./botWallet";
import { notifyUser } from "./notifications";
import type { Message } from "./notificationMessages";
import { getSettings, updateAutonomous, type UserSettings } from "./settings";
import { liveTradingAllowed } from "@/lib/env";
import { executeTrade, prepareLiveSell, refreshPreparedTrade, TradeError } from "./trading";
import { walletFamilyOf } from "./walletResolve";

/**
 * Unattended trading. The bot wallet's key is held by this server (see botWallet.ts), so a trade the bot prepares can be signed and sent
 * here instead of waiting in the user's approval queue. Everything that makes a trade acceptable is unchanged: the same limits, quote,
 * trust rules and affordability check run before anything is signed, and the transaction is refreshed from the market just before it is.
 * What is new is the signing, and these safeguards around it:
 *  - only a trade prepared for the user's own bot wallet is signed, and only once (a claim on the trade is taken first);
 *  - the transaction's signature is recorded BEFORE it is sent, so a transaction that lands is never untracked;
 *  - a trade that can't be completed is failed and reported, never left half done.
 */

const sameAddr = (family: "solana" | "evm", a: string, b: string) => (family === "evm" ? a.toLowerCase() === b.toLowerCase() : a === b);

/** How long one run waits for a token approval to be mined before letting the trade wait for the next run. */
const APPROVAL_WAIT_MS = 20_000;

/** Every address of the user's bot wallets (Solana and EVM). */
export async function botAddresses(userId: string): Promise<string[]> {
  return (await (await collections.botWallets()).find({ userId }, { projection: { address: 1 } }).toArray()).map((w) => w.address);
}

/** True when this position is held in the user's bot wallet, which the server (not the user's browser wallet) signs for. */
export async function isBotPosition(userId: string, pos: Pick<PositionDoc, "walletAddress" | "tokenId">): Promise<boolean> {
  if (!pos.walletAddress) return false;
  const addrs = await botAddresses(userId);
  return addrs.some((a) => a.toLowerCase() === pos.walletAddress!.toLowerCase());
}

export interface BotExecution {
  ok: boolean;
  status: "SENT" | "WAITING_APPROVAL" | "ALREADY_HANDLED" | "FAILED";
  reason?: string;
  signature?: string;
}

async function failBotTrade(trade: TradeDoc, symbol: string, reason: string): Promise<BotExecution> {
  const trades = await collections.trades();
  await trades.updateOne({ _id: trade._id, status: { $in: ["PREPARED", "PENDING"] } }, { $set: { status: "FAILED", failureReason: reason.slice(0, 300), "transaction.status": "FAILED", "transaction.error": reason.slice(0, 300) } });
  await logEvent({ type: "TRADE_FAILED", source: "autonomous", userId: trade.userId, level: trade.side === "SELL" ? "WARN" : "INFO", message: `Bot ${trade.side} of ${symbol} did not go through: ${reason}`, data: { tradeId: trade._id } });
  // a sale that can't be made matters (the position isn't protected); a buy that wasn't made is routine and only logged
  if (trade.side === "SELL") {
    const m: Message = { type: "TRADE_FAILED", title: `Bot could not sell ${symbol}`, body: `${reason}. It will try again at the next check. Open DEX Scout to see the position.`, url: "/positions", tradeId: trade._id, dedupeKey: `botsellfail:${trade.positionId}`, remindAfterMin: 60, priority: "high" };
    await notifyUser(trade.userId, m);
  }
  return { ok: false, status: "FAILED", reason };
}

/**
 * Sign and send a PREPARED trade with the user's bot wallet. Safe to call again for the same trade: it is signed at most once.
 * Returns once the transaction has been sent; the confirmation is booked the normal way (reconcileLiveTrade).
 */
export async function executeBotTrade(userId: string, tradeId: string): Promise<BotExecution> {
  const trades = await collections.trades();
  const trade = await trades.findOne({ _id: tradeId, userId });
  if (!trade || trade.environment !== "LIVE") throw new TradeError("Trade not found", 404);
  const token = await (await collections.tokens()).findOne({ _id: trade.tokenId });
  if (!token) throw new TradeError("Token not found", 404);
  const chain = token.chain as ChainId;
  const family = walletFamilyOf(chain);
  const bot = await getBotWallet(userId, family);
  const preparedFor = (trade.quote as { wallet?: string | null } | null)?.wallet ?? null;
  if (!bot || !preparedFor || !sameAddr(family, bot.address, preparedFor)) throw new TradeError("This trade was not prepared for your bot wallet, so the server will not sign it", 403);

  // take the trade: only one run may sign it
  const claim = await trades.updateOne({ _id: trade._id, status: "PREPARED", botClaimedAt: null }, { $set: { botClaimedAt: new Date() } });
  if (!claim.modifiedCount) return { ok: false, status: "ALREADY_HANDLED" };

  try {
    const refreshed = await refreshPreparedTrade(userId, tradeId, bot.address);
    const sym = token.symbol;

    if (family === "solana") {
      const signed = signSolanaTransaction(refreshed.unsignedTxBase64, await botSolanaKeypair(userId));
      await executeTrade(userId, tradeId, { signature: signed.signature }); // recorded first: from here on a landed transaction is tracked
      try {
        await providers().dex.executeSwap(chain, signed.signedB64);
      } catch (err) {
        return failBotTrade(trade, sym, safeMessage(err));
      }
      return { ok: true, status: "SENT", signature: signed.signature };
    }

    // EVM: a token approval first when the aggregator's contract can't yet move the amount, then the swap
    const payload = JSON.parse(refreshed.unsignedTxBase64) as { approval?: { to: string; data: string; value?: string }; tx: { to: string; data: string; value?: string }; swapGasUnits?: string };
    const account = await botEvmAccount(userId);
    const fresh = (await trades.findOne({ _id: trade._id }))!;
    let approvalHash = fresh.botApprovalHash ?? null;
    if (payload.approval || approvalHash) {
      if (!approvalHash) {
        const approval = await signEvmCall(chain, account, payload.approval!);
        approvalHash = await sendEvmRaw(chain, approval.raw);
        await trades.updateOne({ _id: trade._id }, { $set: { botApprovalHash: approvalHash } });
      }
      const mined = await waitForEvmReceipt(chain, approvalHash, APPROVAL_WAIT_MS);
      if (mined === null) {
        await trades.updateOne({ _id: trade._id }, { $set: { botClaimedAt: null } }); // not mined yet: the next run picks it up
        return { ok: true, status: "WAITING_APPROVAL" };
      }
      if (!mined) return failBotTrade(trade, sym, "The token approval failed on-chain");
    }
    const signed = await signEvmCall(chain, account, payload.tx, { gasFloor: payload.swapGasUnits ? BigInt(payload.swapGasUnits) : undefined });
    await executeTrade(userId, tradeId, { signature: signed.hash }); // recorded first
    try {
      await sendEvmRaw(chain, signed.raw);
    } catch (err) {
      const msg = safeMessage(err);
      if (!/already known|known transaction|already imported/i.test(msg)) return failBotTrade(trade, sym, msg);
    }
    return { ok: true, status: "SENT", signature: signed.hash };
  } catch (err) {
    const reason = err instanceof TradeError && err.violations.length ? err.violations.join("; ") : safeMessage(err);
    const current = await trades.findOne({ _id: trade._id });
    // if the signature was already recorded the trade is in flight and reconciliation owns it; otherwise it did not go out
    if (current?.status === "PREPARED") return failBotTrade(trade, token.symbol, reason);
    return { ok: false, status: "FAILED", reason };
  }
}

/** Trades the bot started whose token approval was still being mined last time: finish them. Called each cycle. */
export async function resumeBotTrades(): Promise<number> {
  const trades = await collections.trades();
  const waiting = await trades.find({ status: "PREPARED", botApprovalHash: { $ne: null }, botClaimedAt: null }).toArray();
  let n = 0;
  for (const t of waiting) {
    const r = await executeBotTrade(t.userId, t._id).catch(() => null);
    if (r?.status === "SENT") n++;
  }
  return n;
}

/** Prepare a sell from the bot wallet and send it at once (no approval queue). */
export async function botSell(userId: string, positionId: string, amount: number, kind: TradeKind, reason: string, level?: number): Promise<BotExecution> {
  // a sale already sent and still confirming will change the position: sending another for the same tokens now would sell them twice
  if (await (await collections.trades()).findOne({ positionId, side: "SELL", status: "PENDING" }, { projection: { _id: 1 } })) return { ok: true, status: "ALREADY_HANDLED" };
  const r = await prepareLiveSell(userId, positionId, amount, kind, reason, level, undefined, { autonomous: true });
  return executeBotTrade(userId, r.trade.id);
}

// ───────────────────────────── the day ─────────────────────────────

export interface AutonomousStatus {
  configured: boolean;
  decision: GovernorDecision;
  dayStartedAt: Date;
  /** the bot wallets hold exposure of this much in open positions, and these many */
  openPositions: number;
  deployedUsd: number;
}

/** What the bot has done today, as events the governor can add up: each confirmed trade of the bot wallet, net of its fees. */
export async function dayEventsFor(userId: string, since: Date): Promise<DayEvent[]> {
  const addrs = await botAddresses(userId);
  if (!addrs.length) return [];
  const trades = await (await collections.trades()).find({ userId, status: "CONFIRMED", executedAt: { $gte: since }, "quote.wallet": { $in: addrs } }).toArray();
  const positionIds = [...new Set(trades.filter((t) => t.side === "SELL" && t.positionId).map((t) => t.positionId!))];
  const positions = positionIds.length ? await (await collections.positions()).find({ _id: { $in: positionIds } }, { projection: { status: 1 } }).toArray() : [];
  const closed = new Set(positions.filter((p) => p.status === "CLOSED").map((p) => p._id));
  // the sale that closed a position is its last one
  const lastSell = new Map<string, string>();
  for (const t of [...trades].sort((a, b) => (a.executedAt ?? a.createdAt).getTime() - (b.executedAt ?? b.createdAt).getTime())) if (t.side === "SELL" && t.positionId) lastSell.set(t.positionId, t._id);
  return trades.map((t): DayEvent => {
    const feeUsd = t.walletChange ? t.walletChange.feeNative * t.walletChange.nativeUsd : t.networkFeeUsd;
    const at = t.executedAt ?? t.createdAt;
    const isSell = t.side === "SELL";
    return { at, netUsd: (isSell ? (t.realizedPnlUsd ?? 0) : 0) - feeUsd, closed: isSell && !!t.positionId && closed.has(t.positionId) && lastSell.get(t.positionId) === t._id };
  });
}

export async function autonomousStatus(userId: string, settings?: UserSettings, now = new Date()): Promise<AutonomousStatus> {
  const s = settings ?? (await getSettings(userId));
  const since = dayStart(now, s.autonomous.dayOffsetMinutes);
  const addrs = await botAddresses(userId);
  const open = addrs.length ? await (await collections.positions()).find({ userId, status: { $ne: "CLOSED" }, walletAddress: { $in: addrs } }).toArray() : [];
  const events = await dayEventsFor(userId, since);
  const decision = evaluateDay(s.autonomous, events, open.map((p) => p.amount * (p.currentPriceUsd - p.entryPriceUsd)), now);
  return { configured: botWalletsConfigured(), decision, dayStartedAt: since, openPositions: open.length, deployedUsd: open.reduce((sum, p) => sum + p.costBasisUsd, 0) };
}

/** Tell the user, once per day per state, when the day's state changes in a way they would want to know. */
export async function announceDay(userId: string, d: GovernorDecision, dayStartedAt: Date): Promise<void> {
  if (d.state !== "ABOVE_TARGET" && d.state !== "TARGET_LOCKED" && d.state !== "LOSS_LIMIT" && d.state !== "COOLDOWN") return;
  const title = { ABOVE_TARGET: "Daily target reached", TARGET_LOCKED: "Bot stopped for the day: target banked", LOSS_LIMIT: "Bot stopped for the day: loss limit", COOLDOWN: "Bot paused after losses" }[d.state];
  await notifyUser(userId, { type: "SYSTEM_ALERT", title, body: d.reason, url: "/bot", dedupeKey: `day:${dayStartedAt.toISOString().slice(0, 10)}:${d.state}`, remindAfterMin: 24 * 60, priority: d.state === "ABOVE_TARGET" ? "default" : "high" });
}

// ───────────────────────────── switching it on and off ─────────────────────────────

/**
 * Save the unattended-trading settings. Switching it ON needs the pieces to be in place (a master key on the server, a bot wallet, LIVE
 * trading allowed) and puts the bot in LIVE and running; switching it OFF pauses the bot entirely, so it does not fall back to queueing
 * trades for approval. Open positions are never touched either way: they keep their sell targets.
 */
export async function setAutonomous(userId: string, input: Parameters<typeof updateAutonomous>[1]) {
  if (input.enabled) {
    if (!botWalletsConfigured()) throw new TradeError("Unattended trading isn't set up on this server: the operator must set BOT_WALLET_KEY (see the Bot wallet page)", 503);
    if (!liveTradingAllowed()) throw new TradeError("LIVE trading is disabled by server configuration", 403);
    if (!(await botAddresses(userId)).length) throw new TradeError("Create a bot wallet first: it is the wallet the bot trades with", 409);
  }
  const settings = await updateAutonomous(userId, input);
  const { setBotState } = await import("@/app/api/bot/_shared");
  if (input.enabled) {
    await (await collections.tradingSettings()).updateOne({ userId }, { $set: { environment: "LIVE", updatedAt: new Date() } });
    await setBotState(userId, "ACTIVE");
  } else {
    await setBotState(userId, "PAUSED");
  }
  return settings;
}

/** Sell every open position of the bot wallet at market, now. The server signs; returns how many sales were sent. */
export async function sellAllBotPositions(userId: string): Promise<{ sent: number; failed: { symbol: string; reason: string }[]; remaining: number }> {
  const addrs = await botAddresses(userId);
  const open = addrs.length ? await (await collections.positions()).find({ userId, status: { $ne: "CLOSED" }, walletAddress: { $in: addrs } }).toArray() : [];
  const tokens = await (await collections.tokens()).find({ _id: { $in: open.map((p) => p.tokenId) } }, { projection: { symbol: 1 } }).toArray();
  const symbol = new Map(tokens.map((t) => [t._id, t.symbol]));
  const start = Date.now();
  let sent = 0;
  const failed: { symbol: string; reason: string }[] = [];
  let done = 0;
  for (const p of open) {
    if (Date.now() - start > 40_000) break; // out of time for this request: pressing it again sends the rest
    done++;
    const r = await botSell(userId, p._id, p.amount, "MANUAL_EXIT", "Sell everything (requested)").catch((e) => ({ ok: false, status: "FAILED" as const, reason: safeMessage(e) }));
    if (r.ok) sent++;
    else failed.push({ symbol: symbol.get(p.tokenId) ?? "?", reason: r.reason ?? r.status });
  }
  return { sent, failed, remaining: open.length - done };
}
