import type { AnyBulkWriteOperation } from "mongodb";
import { DEFAULT_FILTERS } from "@/core/config";
import { withTimeout } from "@/core/providers/http";
import { providers } from "@/core/providers/registry";
import { applyFilters, mergeFilters } from "@/core/scanner/filter";
import type { ScannerFilters, TokenSnapshot } from "@/core/types";
import { collections, newId } from "@/lib/db";
import { logEvent, safeMessage } from "@/lib/events";
import type { LiquidityPoolDoc, TokenDoc, TokenMetricDoc, TokenStage, PriceSnapshotDoc, VolumeSnapshotDoc } from "@/lib/models";
import { allUserFilters } from "./settings";
import { touchWorker } from "./workerState";

export interface ScanResult {
  discovered: number;
  newTokens: number;
  passed: number;
  filtered: number;
  durationMs: number;
}

/** The shared scanner uses the union of all users' filters (or defaults), so no user's band is starved. */
export async function resolveScanFilters(): Promise<ScannerFilters> {
  return mergeFilters(await allUserFilters()) ?? DEFAULT_FILTERS;
}

function tokenSet(s: TokenSnapshot, passed: boolean, stage: TokenStage) {
  const tx1h = s.buys1h + s.sells1h;
  return {
    name: s.name,
    symbol: s.symbol,
    // decimals is immutable per token (set once on insert via $setOnInsert below); including it here too
    // would put the same path in both $set and $setOnInsert on the same upsert, which MongoDB rejects.
    dex: s.dex,
    poolAddress: s.poolAddress,
    poolCreatedAt: s.poolCreatedAt,
    lastScannedAt: new Date(),
    priceUsd: s.priceUsd,
    marketCapUsd: s.marketCapUsd,
    fdvUsd: s.fdvUsd,
    liquidityUsd: s.liquidityUsd,
    volume24hUsd: s.volume24h,
    volume1hUsd: s.volume1h,
    change5m: s.change5m,
    change1h: s.change1h,
    change24h: s.change24h,
    buySellRatio: s.sells1h === 0 ? (s.buys1h > 0 ? 3 : 1) : s.buys1h / s.sells1h,
    holders: Math.max(0, s.holders),
    holderGrowth1h: s.holders > 0 && s.holders1hAgo > 0 ? (s.holders / s.holders1hAgo - 1) * 100 : 0,
    txCount1h: tx1h,
    pairCount: s.pairCount,
    passedFilters: passed,
    stage,
    updatedAt: new Date(),
  };
}

export async function runScanCycle(): Promise<ScanResult> {
  const started = Date.now();
  const p = providers();
  await logEvent({ type: "SCANNER_STARTED", source: "scanner", level: "DEBUG", message: `Scan started (${p.data.name})` });
  try {
    const filters = await resolveScanFilters();
    // Each chain is capped independently so one slow/misbehaving chain (a provider outage, a retry
    // cascade) contributes zero tokens for this tick instead of holding up every other chain's discovery
    // — and, transitively, the whole serverless request's 60s budget (see withTimeout's docstring).
    const snaps = (
      await Promise.all(
        filters.chains.map((c) =>
          withTimeout(p.data.discover(c), 20_000, `discover(${c})`).catch(async (err) => {
            await logEvent({ type: "PROVIDER_ERROR", source: "scanner", level: "WARN", message: `Discovery timed out or failed for ${c}: ${safeMessage(err)}` });
            return [] as TokenSnapshot[];
          }),
        ),
      )
    ).flat();
    const now = new Date();

    const tokens = await collections.tokens();
    const byChain = new Map<string, TokenSnapshot[]>();
    for (const s of snaps) byChain.set(s.chain, [...(byChain.get(s.chain) ?? []), s]);
    const existingByKey = new Map<string, { id: string; stage: TokenStage }>();
    for (const [chain, list] of byChain) {
      const rows = await tokens.find({ chain, address: { $in: list.map((s) => s.address) } }, { projection: { _id: 1, chain: 1, address: 1, stage: 1 } }).toArray();
      for (const r of rows) existingByKey.set(`${r.chain}:${r.address}`, { id: r._id, stage: r.stage });
    }

    let newTokens = 0;
    let passed = 0;
    const tokenIdByAddress = new Map<string, string>();
    const metricRows: TokenMetricDoc[] = [];
    const priceRows: PriceSnapshotDoc[] = [];
    const volRows: VolumeSnapshotDoc[] = [];
    const ops: AnyBulkWriteOperation<TokenDoc>[] = [];

    for (const s of snaps) {
      const res = applyFilters(s, filters, now);
      if (res.passed) passed++;
      const prev = existingByKey.get(`${s.chain}:${s.address}`);
      if (!prev) newTokens++;
      const id = prev?.id ?? newId();
      tokenIdByAddress.set(`${s.chain}:${s.address}`, id);
      // keep pipeline stage monotonic for tokens already analysed; reset to FILTERED when they fall out of band
      const stage: TokenStage = !res.passed ? "FILTERED" : prev && prev.stage !== "FILTERED" && prev.stage !== "DISCOVERED" ? prev.stage : "SCANNED";

      ops.push({
        updateOne: {
          filter: { chain: s.chain, address: s.address },
          update: {
            $set: tokenSet(s, res.passed, stage),
            $setOnInsert: {
              _id: id,
              chain: s.chain,
              address: s.address,
              decimals: s.decimals || 9,
              dataSource: s.dataSource,
              logoUrl: null,
              firstSeenAt: now,
              opportunityScore: 0,
              riskLevel: "MODERATE",
              safety: null,
              analysis: null,
            },
          },
          upsert: true,
        },
      });

      if (res.passed) {
        metricRows.push({
          _id: newId(), tokenId: id, ts: now, priceUsd: s.priceUsd, marketCapUsd: s.marketCapUsd, fdvUsd: s.fdvUsd, liquidityUsd: s.liquidityUsd,
          volume5m: s.volume5m, volume15m: s.volume15m, volume30m: s.volume30m, volume1h: s.volume1h, volume24h: s.volume24h,
          buys5m: s.buys5m, sells5m: s.sells5m, buys1h: s.buys1h, sells1h: s.sells1h, holders: Math.max(0, s.holders), pairCount: s.pairCount,
        });
        priceRows.push({ _id: newId(), tokenId: id, ts: now, priceUsd: s.priceUsd, liquidityUsd: s.liquidityUsd });
        volRows.push({ _id: newId(), tokenId: id, ts: now, volume5m: s.volume5m, volume1h: s.volume1h, volume24h: s.volume24h, buys5m: s.buys5m, sells5m: s.sells5m });
      }
    }

    for (let i = 0; i < ops.length; i += 500) await tokens.bulkWrite(ops.slice(i, i + 500), { ordered: false });

    const [metrics, prices, volumes, pools] = await Promise.all([collections.tokenMetrics(), collections.priceSnapshots(), collections.volumeSnapshots(), collections.liquidityPools()]);
    await Promise.all([
      metricRows.length ? metrics.insertMany(metricRows, { ordered: false }) : null,
      priceRows.length ? prices.insertMany(priceRows, { ordered: false }) : null,
      volRows.length ? volumes.insertMany(volRows, { ordered: false }) : null,
    ]);

    // pool records (one per token/pool)
    const poolOps: AnyBulkWriteOperation<LiquidityPoolDoc>[] = [];
    for (const s of snaps) {
      const tokenId = tokenIdByAddress.get(`${s.chain}:${s.address}`);
      if (!tokenId || !s.poolAddress) continue;
      poolOps.push({
        updateOne: {
          filter: { chain: s.chain, address: s.poolAddress },
          update: {
            $set: { liquidityUsd: s.liquidityUsd, updatedAt: now },
            $setOnInsert: { _id: newId(), tokenId, dex: s.dex, quoteSymbol: "SOL", createdAtChain: s.poolCreatedAt },
          },
          upsert: true,
        },
      });
    }
    for (let i = 0; i < poolOps.length; i += 500) await pools.bulkWrite(poolOps.slice(i, i + 500), { ordered: false });

    if (newTokens > 0) {
      await logEvent({ type: "TOKEN_DISCOVERED", source: "scanner", message: `${newTokens} new token(s) discovered`, data: { newTokens } });
    }
    const filtered = snaps.length - passed;
    const result: ScanResult = { discovered: snaps.length, newTokens, passed, filtered, durationMs: Date.now() - started };
    await logEvent({
      type: "SCANNER_COMPLETED",
      source: "scanner",
      level: "DEBUG",
      message: `Scanned ${snaps.length} tokens: ${passed} passed filters, ${filtered} filtered`,
      data: { ...result },
    });
    await touchWorker("scanner-worker", null, { ...result });
    return result;
  } catch (err) {
    const msg = safeMessage(err);
    await logEvent({ type: "PROVIDER_ERROR", source: "scanner", level: "ERROR", message: `Scan failed: ${msg}` });
    await touchWorker("scanner-worker", msg);
    throw err;
  }
}
