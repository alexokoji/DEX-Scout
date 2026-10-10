import type { ChainId } from "@/core/types";
import { rescore } from "@/core/analysis/scoring";
import { applyFilters } from "@/core/scanner/filter";
import { allocate } from "@/core/trading/capital";
import { collections, newId, withId } from "@/lib/db";
import { liveTradingAllowed } from "@/lib/env";
import { logEvent, safeMessage } from "@/lib/events";
import { capitalState, ensureAnalysis, expirePreparedTrades, prepareTrade, reconcileLiveTrade, TradeError } from "./trading";
import { getSettings } from "./settings";
import { announceDay, autonomousStatus, botAddresses, executeBotTrade, resumeBotTrades, type AutonomousStatus } from "./autonomous";
import { botAddressFor, botWalletsConfigured } from "./botWallet";
import { CHAINS } from "@/core/chains";
import { botNeedsFunds } from "./notificationMessages";
import { entryTiming } from "@/core/analysis/entryTiming";
import { recentCandles, scalpTargets } from "./projection";
import { notifyUser } from "./notifications";
import { touchWorker } from "./workerState";

/** Trade-executor worker: evaluates active BUY signals for every ACTIVE bot and executes eligible ones. */
/** Unattended trades are started only while there is time left in the cycle to finish them (the scheduler gives a run about a minute). */
const ENTRY_BUDGET_MS = 35_000;

/** Buys the bot has started on this chain that haven't landed yet: money that is committed even though the wallet and the positions don't show it. */
async function pendingBuys(userId: string, addrs: string[], chain: string) {
  const rows = await (await collections.trades()).find({ userId, side: "BUY", status: { $in: ["PREPARED", "PENDING"] }, "quote.wallet": { $in: addrs }, "transaction.chain": chain }, { projection: { inputUsd: 1 } }).toArray();
  return { count: rows.length, usd: rows.reduce((s, r) => s + r.inputUsd, 0) };
}

export async function runBotCycle(): Promise<{ bots: number; executed: number; skipped: number }> {
  const cycleStart = Date.now();
  const botsCol = await collections.bots();
  const botRuns = await collections.botRuns();
  const signalsCol = await collections.signals();
  const tokensCol = await collections.tokens();
  const positionsCol = await collections.positions();
  const tradesCol = await collections.trades();

  const bots = await botsCol.find({ status: "ACTIVE" }).toArray();
  let executed = 0;
  let skipped = 0;

  for (const bot of bots) {
    const settings = await getSettings(bot.userId);
    if (!settings.autoTradingEnabled || settings.environment === "MANUAL") continue;
    const env = settings.environment;
    if (env === "LIVE" && !liveTradingAllowed()) {
      await logEvent({ type: "TRADE_SKIPPED", source: "bot", userId: bot.userId, level: "WARN", message: "LIVE auto trading requested but LIVE trading is disabled by configuration" });
      continue;
    }

    const runId = newId();
    await botRuns.insertOne({ _id: runId, botId: bot._id, startedAt: new Date(), finishedAt: null, signalsEvaluated: 0, tradesExecuted: 0, tradesSkipped: 0, error: null, summary: null });
    let evaluated = 0;
    let runExecuted = 0;
    let runSkipped = 0;
    let error: string | null = null;
    const reasons: Record<string, string> = {};

    // Unattended trading: the daily governor decides first whether the bot may open anything today.
    const auto = settings.autonomous.enabled && env === "LIVE" && botWalletsConfigured();
    let day: AutonomousStatus | null = null;
    if (auto) {
      day = await autonomousStatus(bot.userId, settings).catch(() => null);
      if (day) await announceDay(bot.userId, day.decision, day.dayStartedAt);
      if (day && !day.decision.canOpen) reasons["(today)"] = day.decision.reason;
    }

    try {
      const signals = auto && (!day || !day.decision.canOpen) ? [] : await signalsCol.find({ status: "ACTIVE", type: "BUY", expiresAt: { $gt: new Date() } }).sort({ score: -1 }).toArray();
      const tokens = await tokensCol.find({ _id: { $in: [...new Set(signals.map((s) => s.tokenId))] } }).toArray();
      const tokenById = new Map(tokens.map((t) => [t._id, t]));

      for (const sig of signals) {
        evaluated++;
        const token = tokenById.get(sig.tokenId);
        if (!token) continue; // token disappeared from the tracked set
        const skip = (why: string) => {
          runSkipped++;
          reasons[token.symbol] = why;
        };

        const open = await positionsCol.findOne({ userId: bot.userId, tokenId: sig.tokenId, environment: env, status: { $ne: "CLOSED" } });
        if (open) { skip("position already open"); continue; }
        const attempted = await tradesCol.findOne({ userId: bot.userId, tokenId: sig.tokenId, environment: env, kind: "AUTO_ENTRY", createdAt: { $gt: new Date(Date.now() - 30 * 60_000) } });
        if (attempted) { skip("recent attempt"); continue; }

        try {
          const analysis = await ensureAnalysis(withId(token));
          const f = applyFilters(analysis.snapshot, settings.filters);
          if (!f.passed) { skip(`user filters: ${f.reasons[0]}`); continue; }
          const own = rescore(analysis.opportunity.components, settings.weights);
          if (own.score < settings.minOpportunityScore) { skip(`score ${own.score.toFixed(0)} < ${settings.minOpportunityScore}`); continue; }

          if (auto) {
            // Buy a dip, not a climb. First: the signal named a price to buy at; if the market has since run above that zone the move is
            // already under way. Then the chart: the lowest part of the last four hours' range, not two rising candles in a row, and not
            // already up by about what the first target is for.
            const px = analysis.snapshot.priceUsd;
            if (sig.entryMax > 0 && px > sig.entryMax) { skip(`the price has climbed above the signal's entry zone (${px.toPrecision(4)} > ${sig.entryMax.toPrecision(4)}): it started moving before the buy`); continue; }
            const ladder = await scalpTargets(token.chain as ChainId, token.address, settings.targets).catch(() => null);
            const candles = await recentCandles(token.chain as ChainId, token.address);
            const timing = candles ? entryTiming(candles, px, settings.autonomous.entryMaxRangePct, (ladder ?? settings.targets)[0]?.gainPct) : null;
            if (!timing) { skip("no chart to judge the entry by right now"); continue; }
            if (!timing.ok) { skip(timing.reason); continue; }
            // signed by the server with the user's bot wallet: no approval queue
            if (Date.now() - cycleStart > ENTRY_BUDGET_MS) { skip("out of time this cycle; next one"); break; }
            const addr = await botAddressFor(bot.userId, token.chain);
            if (!addr) { skip("no bot wallet for this chain's address family"); continue; }
            const addrs = await botAddresses(bot.userId);
            const state = await capitalState(bot.userId, env, undefined, token.chain as ChainId, addr, addrs);
            const pend = await pendingBuys(bot.userId, addrs, token.chain);
            // a wallet with none of the chain's coin can't pay for anything there, fees included: say so, once in a while, instead of skipping in silence
            if (state.walletUsd != null && state.walletUsd <= 0) {
              await notifyUser(bot.userId, botNeedsFunds(CHAINS[token.chain as ChainId].name, CHAINS[token.chain as ChainId].nativeSymbol, addr));
              skip(`the bot wallet holds none of ${CHAINS[token.chain as ChainId].nativeSymbol} on ${CHAINS[token.chain as ChainId].name}`);
              continue;
            }
            state.deployedUsd += pend.usd;
            state.openPositions += pend.count;
            if (state.walletUsd != null) state.walletUsd = Math.max(0, state.walletUsd - pend.usd);
            const alloc = allocate(settings, state, settings.maxPositionUsd);
            if (!alloc.ok) { skip(alloc.reason); continue; }
            const { trade } = await prepareTrade(
              bot.userId,
              { chain: token.chain as ChainId, tokenAddress: token.address, amountUsd: alloc.amountUsd, slippageBps: Math.min(settings.maxSlippageBps, 300), environment: env, signalId: sig._id, wallet: addr },
              "AUTO_ENTRY",
              { autonomous: true },
            );
            const r = await executeBotTrade(bot.userId, trade.id);
            if (r.ok) { runExecuted++; executed++; } else skip(r.reason ?? r.status);
            await logEvent({ type: "TRADE_EXECUTED", source: "bot", userId: bot.userId, message: `Bot entry for ${token.symbol}: ${r.status}${r.reason ? ` (${r.reason})` : ""}`, data: { tradeId: trade.id } });
            continue;
          }
          const state = await capitalState(bot.userId, env, undefined, token.chain as ChainId);
          const alloc = allocate(settings, state, settings.maxPositionUsd);
          if (!alloc.ok) { skip(alloc.reason); continue; }

          const { trade } = await prepareTrade(
            bot.userId,
            { chain: token.chain as ChainId, tokenAddress: token.address, amountUsd: alloc.amountUsd, slippageBps: Math.min(settings.maxSlippageBps, 300), environment: env, signalId: sig._id },
            "AUTO_ENTRY",
          );
          // The trade waits in the user's wallet-approval queue; the bot cannot sign on its own.
          runExecuted++;
          executed++;
          await logEvent({ type: "TRADE_REQUESTED", source: "bot", userId: bot.userId, message: `LIVE auto entry for ${token.symbol} awaiting wallet approval`, data: { tradeId: trade.id } });
        } catch (err) {
          const msg = err instanceof TradeError && err.violations.length ? err.violations.join("; ") : safeMessage(err);
          skip(msg);
          await logEvent({ type: "TRADE_SKIPPED", source: "bot", userId: bot.userId, level: "INFO", message: `Skipped ${token.symbol}: ${msg}`, data: { signalId: sig._id } });
        }
      }
    } catch (err) {
      error = safeMessage(err);
      await logEvent({ type: "WORKER_ERROR", source: "bot", userId: bot.userId, level: "ERROR", message: `Bot run failed: ${error}` });
    }

    await botRuns.updateOne({ _id: runId }, { $set: { finishedAt: new Date(), signalsEvaluated: evaluated, tradesExecuted: runExecuted, tradesSkipped: runSkipped, error, summary: reasons } });
    await botsCol.updateOne({ _id: bot._id }, { $set: { lastRunAt: new Date(), environment: env, updatedAt: new Date() } });
    skipped += runSkipped;
  }

  // follow up on LIVE trades awaiting on-chain confirmation, and expire stale prepared trades
  await resumeBotTrades().catch(() => {});
  await expirePreparedTrades();
  const pending = await tradesCol.find({ status: "PENDING", environment: "LIVE" }, { projection: { _id: 1 } }).toArray();
  for (const t of pending) await reconcileLiveTrade(t._id).catch(() => {});

  await touchWorker("trade-executor-worker", null, { bots: bots.length, executed, skipped });
  return { bots: bots.length, executed, skipped };
}
