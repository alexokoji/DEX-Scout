import { buildAnalysis } from "@/core/analysis/pipeline";
import { SIGNAL_THRESHOLDS } from "@/core/config";
import { providers } from "@/core/providers/registry";
import type { Analysis, ChainId, OnChainRaw, TokenSnapshot } from "@/core/types";
import { collections } from "@/lib/db";
import { logEvent, safeMessage } from "@/lib/events";
import { touchWorker } from "./workerState";

const CONCURRENCY = 8;

export async function analyzeSnapshot(s: TokenSnapshot, raw: OnChainRaw): Promise<Analysis> {
  const candles = await providers().data.getCandles(s.chain, s.address, "5m", 120);
  return buildAnalysis(s, raw, candles, "5m");
}

export async function persistAnalysis(tokenId: string, a: Analysis): Promise<void> {
  const qualified = a.safety.passed && a.opportunity.score >= SIGNAL_THRESHOLDS.watch;
  const now = new Date();
  const tokens = await collections.tokens();
  await tokens.updateOne(
    { _id: tokenId },
    {
      $set: {
        opportunityScore: a.opportunity.score,
        riskLevel: a.safety.riskLevel,
        stage: qualified ? "QUALIFIED" : "ANALYZED",
        safety: {
          riskScore: a.safety.riskScore,
          riskLevel: a.safety.riskLevel,
          passed: a.safety.passed,
          warnings: a.safety.warnings,
          criticalIssues: a.safety.criticalIssues,
          details: a.onchainRaw,
          checkedAt: now,
        },
        analysis: {
          opportunityScore: a.opportunity.score,
          components: a.opportunity.components,
          market: a.market,
          onchain: a.onchain,
          snapshot: a.snapshot,
          raw: a.onchainRaw,
          computedAt: now,
          updatedAt: now,
        },
      },
    },
  );
}

/** Rebuild the in-memory Analysis for a token from persisted fields (used by the signal worker and pages). */
export async function loadAnalysis(tokenId: string): Promise<Analysis | null> {
  const tokens = await collections.tokens();
  const t = await tokens.findOne({ _id: tokenId }, { projection: { safety: 1, analysis: 1 } });
  if (!t?.analysis || !t.safety) return null;
  const snap = t.analysis.snapshot;
  const snapshot: TokenSnapshot = { ...snap, poolCreatedAt: new Date(snap.poolCreatedAt), observedAt: new Date(snap.observedAt) };
  return {
    snapshot,
    onchainRaw: t.analysis.raw,
    safety: {
      riskScore: t.safety.riskScore,
      riskLevel: t.safety.riskLevel,
      passed: t.safety.passed,
      warnings: t.safety.warnings,
      criticalIssues: t.safety.criticalIssues,
    },
    market: t.analysis.market,
    onchain: t.analysis.onchain,
    opportunity: { score: t.analysis.opportunityScore, components: t.analysis.components },
    computedAt: t.analysis.computedAt,
  };
}

async function inChunks<T>(items: T[], size: number, fn: (t: T) => Promise<void>) {
  for (let i = 0; i < items.length; i += size) await Promise.all(items.slice(i, i + size).map(fn));
}

/**
 * Safety + market + on-chain analysis for tokens that currently pass the scanner filters.
 *
 * `limit` bounds how many tokens a single call analyses (each one costs at least two outbound HTTP
 * calls, so on a hard wall-clock budget — the Vercel serverless cron route, capped at 60s on Hobby —
 * an unbounded pass across hundreds of live tokens can blow past it and the platform kills the whole
 * request with a 500 before anything gets persisted). Never-analysed tokens are always prioritised,
 * then the ones with the oldest analysis, so nothing is permanently skipped — it's paced across
 * however many cron ticks it takes, not capped. The self-hosted worker loop (no wall-clock ceiling)
 * calls this with no limit.
 */
export async function runAnalysisCycle(limit?: number): Promise<{ analyzed: number; failed: number }> {
  const p = providers();
  const tokenCol = await collections.tokens();
  const [unanalyzed, stale] = await Promise.all([
    tokenCol
      .find({ passedFilters: true, analysis: null }, { projection: { _id: 1, address: 1, chain: 1 } })
      .sort({ marketCapUsd: -1 })
      .toArray(),
    tokenCol
      .find({ passedFilters: true, analysis: { $ne: null } }, { projection: { _id: 1, address: 1, chain: 1 } })
      .sort({ "analysis.computedAt": 1 })
      .toArray(),
  ]);
  const ordered = [...unanalyzed, ...stale];
  const tokens = limit ? ordered.slice(0, limit) : ordered;
  let analyzed = 0;
  let failed = 0;
  let critical = 0;
  await inChunks(tokens, CONCURRENCY, async (t) => {
    try {
      const snap = await p.data.getSnapshot(t.chain as ChainId, t.address);
      if (!snap) {
        failed++;
        // The provider can no longer resolve this token (delisted, too new for this source, or — after a
        // MOCK -> LIVE switch — a synthetic address that never existed on-chain). Left marked as passing,
        // it would be retried forever and, under the serverless batch cap, could permanently crowd out
        // real candidates that are actually ready to analyse. Demote it instead of leaving it stuck.
        await tokenCol.updateOne({ _id: t._id }, { $set: { passedFilters: false, stage: "FILTERED" } });
        return;
      }
      const raw = await p.data.getOnChain(t.chain as ChainId, t.address, snap);
      const a = await analyzeSnapshot(snap, raw);
      if (a.safety.criticalIssues.length) critical++;
      await persistAnalysis(t._id, a);
      analyzed++;
    } catch (err) {
      failed++;
      await logEvent({ type: "PROVIDER_ERROR", source: "analysis", level: "WARN", message: `Analysis failed for ${t.address}: ${safeMessage(err)}` });
    }
  });
  await logEvent({
    type: "SAFETY_CHECK_COMPLETED",
    source: "analysis",
    level: "DEBUG",
    message: `Analysed ${analyzed} tokens (${critical} with critical issues, ${failed} failed)${limit ? `, ${ordered.length - tokens.length} left for the next run` : ""}`,
    data: { analyzed, failed, critical, remaining: ordered.length - tokens.length },
  });
  await touchWorker("analysis-worker", failed && !analyzed ? "All analyses failed" : null, { analyzed, failed, critical });
  return { analyzed, failed };
}
