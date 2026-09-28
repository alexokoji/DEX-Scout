import type { ChainId } from "@/core/types";
import { rescore } from "@/core/analysis/scoring";
import { applyFilters } from "@/core/scanner/filter";
import { allocate } from "@/core/trading/capital";
import { collections, newId, withId } from "@/lib/db";
import { liveTradingAllowed } from "@/lib/env";
import { logEvent, safeMessage } from "@/lib/events";
import { capitalState, ensureAnalysis, executeTrade, prepareTrade, reconcileLiveTrade, TradeError } from "./trading";
import { getSettings } from "./settings";
import { touchWorker } from "./workerState";

/** Trade-executor worker: evaluates active BUY signals for every ACTIVE bot and executes eligible ones. */
export async function runBotCycle(): Promise<{ bots: number; executed: number; skipped: number }> {
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

    try {
      const signals = await signalsCol.find({ status: "ACTIVE", type: "BUY", expiresAt: { $gt: new Date() } }).sort({ score: -1 }).toArray();
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

          const state = await capitalState(bot.userId, env);
          const alloc = allocate(settings, state, settings.maxPositionUsd);
          if (!alloc.ok) { skip(alloc.reason); continue; }

          const { trade } = await prepareTrade(
            bot.userId,
            { chain: token.chain as ChainId, tokenAddress: token.address, amountUsd: alloc.amountUsd, slippageBps: Math.min(settings.maxSlippageBps, 300), environment: env, signalId: sig._id },
            "AUTO_ENTRY",
          );
          if (env === "PAPER") {
            const res = await executeTrade(bot.userId, trade.id);
            if (res && "ok" in res && res.ok) { runExecuted++; executed++; } else skip("paper fill failed");
          } else {
            // LIVE: the trade waits in the user's wallet-approval queue; the bot cannot sign on its own.
            runExecuted++;
            executed++;
            await logEvent({ type: "TRADE_REQUESTED", source: "bot", userId: bot.userId, message: `LIVE auto entry for ${token.symbol} awaiting wallet approval`, data: { tradeId: trade.id } });
          }
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
  await tradesCol.updateMany({ status: "PREPARED", expiresAt: { $lt: new Date() } }, { $set: { status: "EXPIRED" } });
  const pending = await tradesCol.find({ status: "PENDING", environment: "LIVE" }, { projection: { _id: 1 } }).toArray();
  for (const t of pending) await reconcileLiveTrade(t._id).catch(() => {});

  await touchWorker("trade-executor-worker", null, { bots: bots.length, executed, skipped });
  return { bots: bots.length, executed, skipped };
}
