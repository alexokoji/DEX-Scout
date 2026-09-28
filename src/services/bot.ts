import type { ChainId } from "@/core/types";
import { rescore } from "@/core/analysis/scoring";
import { applyFilters } from "@/core/scanner/filter";
import { allocate } from "@/core/trading/capital";
import { db } from "@/lib/db";
import { liveTradingAllowed } from "@/lib/env";
import { logEvent, safeMessage } from "@/lib/events";
import { capitalState, ensureAnalysis, executeTrade, prepareTrade, reconcileLiveTrade, TradeError } from "./trading";
import { getSettings } from "./settings";
import { touchWorker } from "./workerState";

/** Trade-executor worker: evaluates active BUY signals for every ACTIVE bot and executes eligible ones. */
export async function runBotCycle(): Promise<{ bots: number; executed: number; skipped: number }> {
  const bots = await db.bot.findMany({ where: { status: "ACTIVE" } });
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

    const run = await db.botRun.create({ data: { botId: bot.id } });
    let evaluated = 0;
    let runExecuted = 0;
    let runSkipped = 0;
    let error: string | null = null;
    const reasons: Record<string, string> = {};

    try {
      const signals = await db.signal.findMany({
        where: { status: "ACTIVE", type: "BUY", expiresAt: { gt: new Date() } },
        include: { token: true },
        orderBy: { score: "desc" },
      });
      for (const sig of signals) {
        evaluated++;
        const skip = (why: string) => {
          runSkipped++;
          reasons[sig.token.symbol] = why;
        };

        const open = await db.position.findFirst({ where: { userId: bot.userId, tokenId: sig.tokenId, environment: env, status: { not: "CLOSED" } } });
        if (open) { skip("position already open"); continue; }
        const attempted = await db.trade.findFirst({
          where: { userId: bot.userId, tokenId: sig.tokenId, environment: env, kind: "AUTO_ENTRY", createdAt: { gt: new Date(Date.now() - 30 * 60_000) } },
        });
        if (attempted) { skip("recent attempt"); continue; }

        try {
          const analysis = await ensureAnalysis(sig.token);
          const f = applyFilters(analysis.snapshot, settings.filters);
          if (!f.passed) { skip(`user filters: ${f.reasons[0]}`); continue; }
          const own = rescore(analysis.opportunity.components, settings.weights);
          if (own.score < settings.minOpportunityScore) { skip(`score ${own.score.toFixed(0)} < ${settings.minOpportunityScore}`); continue; }

          const state = await capitalState(db, bot.userId, env);
          const alloc = allocate(settings, state, settings.maxPositionUsd);
          if (!alloc.ok) { skip(alloc.reason); continue; }

          const { trade } = await prepareTrade(
            bot.userId,
            { chain: sig.token.chain as ChainId, tokenAddress: sig.token.address, amountUsd: alloc.amountUsd, slippageBps: Math.min(settings.maxSlippageBps, 300), environment: env, signalId: sig.id },
            "AUTO_ENTRY",
          );
          if (env === "PAPER") {
            const res = await executeTrade(bot.userId, trade.id);
            if (res && "ok" in res && res.ok) { runExecuted++; executed++; } else skip("paper fill failed");
          } else {
            // LIVE: the trade waits in the user's wallet-approval queue; the bot cannot sign on its own.
            runExecuted++;
            executed++;
            await logEvent({ type: "TRADE_REQUESTED", source: "bot", userId: bot.userId, message: `LIVE auto entry for ${sig.token.symbol} awaiting wallet approval`, data: { tradeId: trade.id } });
          }
        } catch (err) {
          const msg = err instanceof TradeError && err.violations.length ? err.violations.join("; ") : safeMessage(err);
          skip(msg);
          await logEvent({ type: "TRADE_SKIPPED", source: "bot", userId: bot.userId, level: "INFO", message: `Skipped ${sig.token.symbol}: ${msg}`, data: { signalId: sig.id } });
        }
      }
    } catch (err) {
      error = safeMessage(err);
      await logEvent({ type: "WORKER_ERROR", source: "bot", userId: bot.userId, level: "ERROR", message: `Bot run failed: ${error}` });
    }

    await db.botRun.update({
      where: { id: run.id },
      data: { finishedAt: new Date(), signalsEvaluated: evaluated, tradesExecuted: runExecuted, tradesSkipped: runSkipped, error, summary: reasons },
    });
    await db.bot.update({ where: { id: bot.id }, data: { lastRunAt: new Date(), environment: env } });
    skipped += runSkipped;
  }

  // follow up on LIVE trades awaiting on-chain confirmation, and expire stale prepared trades
  await db.trade.updateMany({ where: { status: "PREPARED", expiresAt: { lt: new Date() } }, data: { status: "EXPIRED" } });
  const pending = await db.trade.findMany({ where: { status: "PENDING", environment: "LIVE" }, select: { id: true } });
  for (const t of pending) await reconcileLiveTrade(t.id).catch(() => {});

  await touchWorker("trade-executor-worker", null, { bots: bots.length, executed, skipped });
  return { bots: bots.length, executed, skipped };
}
