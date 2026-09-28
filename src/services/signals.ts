import { aiAnalysisSchema, type AiAnalysis, type AiInput } from "@/core/ai/schema";
import { RulesAiProvider } from "@/core/providers/mock/mockProviders";
import { providers } from "@/core/providers/registry";
import { generateSignal } from "@/core/signals/engine";
import type { Analysis, SignalDraft } from "@/core/types";
import { collections, newId } from "@/lib/db";
import { logEvent, safeMessage } from "@/lib/events";
import type { Json } from "@/lib/models";
import { loadAnalysis } from "./analysis";
import { touchWorker } from "./workerState";

const ANALYSIS_MAX_AGE_MS = 10 * 60_000;

export function toAiInput(a: Analysis, type: SignalDraft["type"], strategySummary: string): AiInput {
  const s = a.snapshot;
  return {
    symbol: s.symbol,
    name: s.name,
    priceUsd: s.priceUsd,
    marketCapUsd: s.marketCapUsd,
    liquidityUsd: s.liquidityUsd,
    volume24hUsd: s.volume24h,
    change5m: s.change5m,
    change1h: s.change1h,
    buySellRatio: a.market.buySellRatio,
    holders: Math.max(0, s.holders),
    holderGrowthPct1h: a.onchain.holderGrowthPct1h,
    liquidityTrendPct: a.market.liquidityTrend,
    volumeSpike: a.market.indicators.volumeSpike,
    trend: a.market.trend,
    rsi14: a.market.indicators.rsi14,
    breakout: a.market.breakout,
    pullback: a.market.pullback,
    whaleBias: a.onchain.whaleBias,
    topHolderPct: a.onchain.topHolderPct,
    riskLevel: a.safety.riskLevel,
    criticalIssues: a.safety.criticalIssues,
    warnings: a.safety.warnings.slice(0, 8),
    opportunityScore: a.opportunity.score,
    signalType: type,
    strategySummary,
  };
}

/**
 * Ask the configured AI provider to interpret the structured analysis. Output is Zod-validated; on any failure the
 * deterministic rules-based summariser is used instead. The result is display-only and never gates a trade.
 */
export async function generateAiAnalysis(a: Analysis, type: SignalDraft["type"]): Promise<{ ai: AiAnalysis; provider: string }> {
  const input = toAiInput(a, type, "score/risk/trend thresholds from the default scanner strategy");
  const p = providers().ai;
  try {
    return { ai: aiAnalysisSchema.parse(await p.analyze(input)), provider: p.name };
  } catch (err) {
    if (p.isLlm) {
      await logEvent({ type: "PROVIDER_ERROR", source: "ai", level: "WARN", message: `AI provider failed, using rules-based summary: ${safeMessage(err)}` });
    }
    const fallback = new RulesAiProvider();
    return { ai: await fallback.analyze(input), provider: fallback.name };
  }
}

export async function runSignalCycle(): Promise<{ created: number; updated: number; expired: number }> {
  const now = new Date();
  let created = 0;
  let updated = 0;
  let expired = 0;

  const signalsCol = await collections.signals();
  const tokensCol = await collections.tokens();

  // 1. time-based expiry
  const timedOut = await signalsCol.updateMany({ status: "ACTIVE", expiresAt: { $lt: now } }, { $set: { status: "EXPIRED", updatedAt: now } });
  expired += timedOut.modifiedCount;

  // 2. evaluate every analysed token that still passes the scanner filters (no cap on results)
  const tokens = await tokensCol
    .find({ passedFilters: true, stage: { $in: ["ANALYZED", "QUALIFIED", "SIGNAL_GENERATED"] } }, { projection: { _id: 1, symbol: 1, dataSource: 1 } })
    .toArray();

  for (const t of tokens) {
    try {
      const analysis = await loadAnalysis(t._id);
      if (!analysis || now.getTime() - analysis.computedAt.getTime() > ANALYSIS_MAX_AGE_MS) continue;
      const draft = generateSignal(analysis, undefined, now);
      const active = await signalsCol.findOne({ tokenId: t._id, status: "ACTIVE" }, { sort: { createdAt: -1 } });

      if (!draft) {
        if (active) {
          await signalsCol.updateOne({ _id: active._id }, { $set: { status: "EXPIRED", updatedAt: now } });
          await tokensCol.updateOne({ _id: t._id }, { $set: { stage: "QUALIFIED" } });
          await logEvent({ type: "SIGNAL_EXPIRED", source: "signals", message: `${t.symbol} ${active.type} signal no longer qualifies`, data: { signalId: active._id } });
          expired++;
        }
        continue;
      }

      const fields = {
        score: draft.score,
        opportunityScore: draft.opportunityScore,
        riskLevel: draft.riskLevel,
        priceUsd: draft.priceUsd,
        entryMin: draft.entryMin,
        entryMax: draft.entryMax,
        target1: draft.target1,
        target2: draft.target2,
        target3: draft.target3,
        reasons: draft.reasons,
        warnings: draft.warnings,
        expiresAt: draft.expiresAt,
        updatedAt: now,
      };

      if (active && active.type === draft.type) {
        await signalsCol.updateOne({ _id: active._id }, { $set: { ...fields, "analysis.snapshot": snapshotJson(analysis) } });
        updated++;
        continue;
      }
      if (active) {
        await signalsCol.updateOne({ _id: active._id }, { $set: { status: "EXPIRED", updatedAt: now } });
        expired++;
      }

      const { ai, provider } = await generateAiAnalysis(analysis, draft.type);
      const signalId = newId();
      await signalsCol.insertOne({
        _id: signalId,
        tokenId: t._id,
        type: draft.type,
        status: "ACTIVE",
        dataSource: t.dataSource,
        ...fields,
        createdAt: now,
        analysis: { snapshot: snapshotJson(analysis), ai, aiProvider: provider, createdAt: now },
      });
      await tokensCol.updateOne({ _id: t._id }, { $set: { stage: "SIGNAL_GENERATED" } });
      await logEvent({
        type: "SIGNAL_CREATED",
        source: "signals",
        message: `${draft.type} signal for ${t.symbol} (score ${draft.score.toFixed(0)}, ${draft.riskLevel} risk)`,
        data: { signalId, tokenId: t._id, type: draft.type, score: draft.score },
      });
      created++;
    } catch (err) {
      await logEvent({ type: "WORKER_ERROR", source: "signals", level: "ERROR", message: `Signal evaluation failed for ${t.symbol}: ${safeMessage(err)}` });
    }
  }

  await touchWorker("signal-worker", null, { created, updated, expired });
  return { created, updated, expired };
}

function snapshotJson(a: Analysis): Json {
  return {
    market: a.market,
    onchain: a.onchain,
    safety: a.safety,
    opportunity: a.opportunity,
    price: a.snapshot.priceUsd,
    marketCapUsd: a.snapshot.marketCapUsd,
    liquidityUsd: a.snapshot.liquidityUsd,
    volume24hUsd: a.snapshot.volume24h,
    computedAt: a.computedAt.toISOString(),
  } as unknown as Json;
}
