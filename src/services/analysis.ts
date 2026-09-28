import type { Prisma } from "@prisma/client";
import { buildAnalysis } from "@/core/analysis/pipeline";
import { SIGNAL_THRESHOLDS } from "@/core/config";
import { providers } from "@/core/providers/registry";
import type { Analysis, ChainId, MarketAnalysis, OnChainAnalysis, OnChainRaw, SafetyResult, TokenSnapshot } from "@/core/types";
import { db } from "@/lib/db";
import { logEvent, safeMessage } from "@/lib/events";
import { touchWorker } from "./workerState";

const CONCURRENCY = 8;

export async function analyzeSnapshot(s: TokenSnapshot, raw: OnChainRaw): Promise<Analysis> {
  const candles = await providers().data.getCandles(s.chain, s.address, "5m", 120);
  return buildAnalysis(s, raw, candles, "5m");
}

export async function persistAnalysis(tokenId: string, a: Analysis): Promise<void> {
  const qualified = a.safety.passed && a.opportunity.score >= SIGNAL_THRESHOLDS.watch;
  await db.$transaction([
    db.tokenSafety.upsert({
      where: { tokenId },
      create: {
        tokenId,
        riskScore: a.safety.riskScore,
        riskLevel: a.safety.riskLevel,
        passed: a.safety.passed,
        warnings: a.safety.warnings,
        criticalIssues: a.safety.criticalIssues,
        details: a.onchainRaw as unknown as Prisma.InputJsonValue,
      },
      update: {
        riskScore: a.safety.riskScore,
        riskLevel: a.safety.riskLevel,
        passed: a.safety.passed,
        warnings: a.safety.warnings,
        criticalIssues: a.safety.criticalIssues,
        details: a.onchainRaw as unknown as Prisma.InputJsonValue,
        checkedAt: new Date(),
      },
    }),
    db.tokenAnalysis.upsert({
      where: { tokenId },
      create: {
        tokenId,
        opportunityScore: a.opportunity.score,
        components: a.opportunity.components as unknown as Prisma.InputJsonValue,
        market: a.market as unknown as Prisma.InputJsonValue,
        onchain: a.onchain as unknown as Prisma.InputJsonValue,
        snapshot: a.snapshot as unknown as Prisma.InputJsonValue,
        raw: a.onchainRaw as unknown as Prisma.InputJsonValue,
      },
      update: {
        opportunityScore: a.opportunity.score,
        components: a.opportunity.components as unknown as Prisma.InputJsonValue,
        market: a.market as unknown as Prisma.InputJsonValue,
        onchain: a.onchain as unknown as Prisma.InputJsonValue,
        snapshot: a.snapshot as unknown as Prisma.InputJsonValue,
        raw: a.onchainRaw as unknown as Prisma.InputJsonValue,
        computedAt: new Date(),
      },
    }),
    db.token.update({
      where: { id: tokenId },
      data: {
        opportunityScore: a.opportunity.score,
        riskLevel: a.safety.riskLevel,
        stage: qualified ? "QUALIFIED" : "ANALYZED",
      },
    }),
  ]);
}

/** Rebuild the in-memory Analysis for a token from persisted rows (used by the signal worker and pages). */
export async function loadAnalysis(tokenId: string): Promise<Analysis | null> {
  const [row, safety] = await Promise.all([
    db.tokenAnalysis.findUnique({ where: { tokenId } }),
    db.tokenSafety.findUnique({ where: { tokenId } }),
  ]);
  if (!row || !safety) return null;
  const snap = row.snapshot as unknown as TokenSnapshot;
  const snapshot: TokenSnapshot = { ...snap, poolCreatedAt: new Date(snap.poolCreatedAt), observedAt: new Date(snap.observedAt) };
  return {
    snapshot,
    onchainRaw: row.raw as unknown as OnChainRaw,
    safety: {
      riskScore: safety.riskScore,
      riskLevel: safety.riskLevel,
      passed: safety.passed,
      warnings: safety.warnings as string[],
      criticalIssues: safety.criticalIssues as string[],
    } satisfies SafetyResult,
    market: row.market as unknown as MarketAnalysis,
    onchain: row.onchain as unknown as OnChainAnalysis,
    opportunity: { score: row.opportunityScore, components: row.components as unknown as Analysis["opportunity"]["components"] },
    computedAt: row.computedAt,
  };
}

async function inChunks<T>(items: T[], size: number, fn: (t: T) => Promise<void>) {
  for (let i = 0; i < items.length; i += size) await Promise.all(items.slice(i, i + size).map(fn));
}

/** Safety + market + on-chain analysis for every token that currently passes the scanner filters. */
export async function runAnalysisCycle(): Promise<{ analyzed: number; failed: number }> {
  const p = providers();
  const tokens = await db.token.findMany({
    where: { passedFilters: true },
    select: { id: true, address: true, chain: true },
    orderBy: { marketCapUsd: "desc" },
  });
  let analyzed = 0;
  let failed = 0;
  let critical = 0;
  await inChunks(tokens, CONCURRENCY, async (t) => {
    try {
      const snap = await p.data.getSnapshot(t.chain as ChainId, t.address);
      if (!snap) {
        failed++;
        return;
      }
      const raw = await p.data.getOnChain(t.chain as ChainId, t.address, snap);
      const a = await analyzeSnapshot(snap, raw);
      if (a.safety.criticalIssues.length) critical++;
      await persistAnalysis(t.id, a);
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
    message: `Analysed ${analyzed} tokens (${critical} with critical issues, ${failed} failed)`,
    data: { analyzed, failed, critical },
  });
  await touchWorker("analysis-worker", failed && !analyzed ? "All analyses failed" : null, { analyzed, failed, critical });
  return { analyzed, failed };
}
