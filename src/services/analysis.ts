import { buildAnalysis } from "@/core/analysis/pipeline";
import { SIGNAL_THRESHOLDS } from "@/core/config";
import { withTimeout } from "@/core/providers/http";
import { providers } from "@/core/providers/registry";
import { applyFilters } from "@/core/scanner/filter";
import type { Analysis, Candle, ChainId, OnChainRaw, TokenSnapshot } from "@/core/types";
import { collections } from "@/lib/db";
import { logEvent, safeMessage } from "@/lib/events";
import { resolveScanFilters } from "./scanner";
import { touchWorker } from "./workerState";

const CONCURRENCY = 8;
// Bounds one token's ENTIRE getSnapshot -> getOnChain -> analyzeSnapshot chain, regardless of which
// provider is slow or how many times a shared pacing queue retries underneath it. Since CONCURRENCY
// tokens run as one Promise.all batch, this caps that whole batch's wall-clock at ~this value no matter
// what any individual provider does — the hard backstop behind the more specific per-provider timeouts
// (6s on-chain RPC calls, 6s candle fetch — see EVM/Solana providers and CANDLE_FETCH_DEADLINE_MS below,
// whose worst cases already sum to ~20s). A token that times out here isn't demoted, since it's a
// provider being slow this cycle, not proof the token itself is unresolvable; it's retried next, subject
// to the cooldown below.
const PER_TOKEN_DEADLINE_MS = 25_000;
// After any analysis attempt (success, failure, or timeout), a token won't be re-selected for this long.
// Without this, a token that keeps failing (e.g. a genuinely bad RPC/indexer entry) can keep re-winning
// every cron tick's small batch by virtue of sorting first, starving fresh candidates that would
// otherwise succeed — the exact "wasting resources on repeat failures" problem this guards against.
const ANALYSIS_COOLDOWN_MS = 10 * 60_000;

// Candles can be queued behind other calls in geckoFetch's shared pace queue before its own per-attempt
// timeout even starts counting, so bounding just that inner attempt isn't enough to keep this decoupled
// from batch size / queue depth. This wraps the whole wait (queue + attempt) so a token's candle step
// never costs it more than this, regardless of how many other tokens are competing for the same queue.
const CANDLE_FETCH_DEADLINE_MS = 6_000;

/**
 * Candles are enrichment, not a requirement: analyzeMarket degrades to neutral/null technicals on an
 * empty array and still scores price/volume/buy-sell-pressure straight from the snapshot. Treating a
 * slow or rate-limited GeckoTerminal response as fatal needlessly failed tokens that had everything else
 * needed for a real opportunity score — this is the main lever behind tokens not showing up to trade.
 */
export async function analyzeSnapshot(s: TokenSnapshot, raw: OnChainRaw): Promise<Analysis> {
  const candles: Candle[] = await withTimeout(providers().data.getCandles(s.chain, s.address, "5m", 120), CANDLE_FETCH_DEADLINE_MS, "candles").catch(() => []);
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
        lastAnalysisAttemptAt: now,
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
  const filters = await resolveScanFilters();
  const notCoolingDown = { $or: [{ lastAnalysisAttemptAt: null }, { lastAnalysisAttemptAt: { $lt: new Date(Date.now() - ANALYSIS_COOLDOWN_MS) } }] };
  const [unanalyzed, stale] = await Promise.all([
    tokenCol
      .find({ passedFilters: true, analysis: null, ...notCoolingDown }, { projection: { _id: 1, address: 1, chain: 1 } })
      .sort({ marketCapUsd: -1 })
      .toArray(),
    tokenCol
      .find({ passedFilters: true, analysis: { $ne: null }, ...notCoolingDown }, { projection: { _id: 1, address: 1, chain: 1 } })
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
      await withTimeout(
        (async () => {
          const snap = await p.data.getSnapshot(t.chain as ChainId, t.address);
          if (!snap) {
            failed++;
            // The provider can no longer resolve this token (delisted, too new for this source, or — after
            // a MOCK -> LIVE switch — a synthetic address that never existed on-chain). Left marked as
            // passing, it would be retried forever and, under the serverless batch cap, could permanently
            // crowd out real candidates that are actually ready to analyse. Demote it instead of leaving it
            // stuck.
            await tokenCol.updateOne({ _id: t._id }, { $set: { passedFilters: false, stage: "FILTERED", lastAnalysisAttemptAt: new Date() } });
            return;
          }
          // Re-check against a FRESH snapshot before spending an on-chain call + a gecko-queue slot: the
          // scan that set passedFilters could be several cron ticks stale under a small serverless batch,
          // and a thin/volatile pool's liquidity can easily have dropped back out of range since. Catching
          // that here is the efficient place to do it — cheap (just this one already-fetched snapshot) vs.
          // spending the expensive calls first only to end up with an analysis nobody can act on anyway.
          const recheck = applyFilters(snap, filters);
          if (!recheck.passed) {
            failed++;
            await tokenCol.updateOne({ _id: t._id }, { $set: { passedFilters: false, stage: "FILTERED", lastAnalysisAttemptAt: new Date() } });
            return;
          }
          const raw = await p.data.getOnChain(t.chain as ChainId, t.address, snap);
          const a = await analyzeSnapshot(snap, raw);
          if (a.safety.criticalIssues.length) critical++;
          await persistAnalysis(t._id, a);
          analyzed++;
        })(),
        PER_TOKEN_DEADLINE_MS,
        `analysis of ${t.chain}:${t.address}`,
      );
    } catch (err) {
      failed++;
      await tokenCol.updateOne({ _id: t._id }, { $set: { lastAnalysisAttemptAt: new Date() } }).catch(() => {});
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
