import type { AnyBulkWriteOperation } from "mongodb";
import { CHAIN_IDS } from "@/core/chains";
import { DEFAULT_FILTERS } from "@/core/config";
import { withTimeout } from "@/core/providers/http";
import { providers } from "@/core/providers/registry";
import { applyFilters, mergeFilters } from "@/core/scanner/filter";
import { pickRotation } from "@/core/scanner/rotation";
import type { ChainId, ScannerFilters, TokenSnapshot } from "@/core/types";
import { collections, newId } from "@/lib/db";
import { env } from "@/lib/env";
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

const CURSOR_ID = "scan-cursor";

/**
 * Which of the enabled chains to discover on this tick. GeckoTerminal is paced (~one call per 2.2s, process-wide), so
 * discovering every chain every tick costs more the more chains exist. Instead each tick takes the next `perTick`
 * chains from a cursor persisted in workerStates, so the cost per tick is constant and every chain still comes round.
 * The cursor is only advanced by the (leased) scan job, so there is a single writer.
 */
export async function chainsForThisTick(enabled: ChainId[], perTick: number): Promise<{ chains: ChainId[]; of: number }> {
  const ordered = CHAIN_IDS.filter((c) => enabled.includes(c));
  if (perTick <= 0 || ordered.length <= perTick) return { chains: ordered, of: ordered.length };
  const states = await collections.workerStates();
  const row = await states.findOne({ _id: CURSOR_ID });
  const stored = (row?.stats as { cursor?: unknown } | null)?.cursor;
  const cursor = typeof stored === "number" ? stored : 0;
  const { picked, next } = pickRotation(ordered, cursor, perTick);
  const now = new Date();
  await states.updateOne({ _id: CURSOR_ID }, { $set: { stats: { cursor: next }, updatedAt: now, lastRunAt: now }, $setOnInsert: { leaseUntil: null, lastError: null, runs: 0 } }, { upsert: true });
  return { chains: picked, of: ordered.length };
}

/** Per chain per tick: how many already-tracked tokens get a price refresh (DexScreener batches of 30, up to 5 requests). */
const REFRESH_PER_CHAIN = 150;

/**
 * Re-fetch prices for tracked tokens on this tick's chains that weren't just discovered. Tokens someone is exposed to
 * come first (open positions, active signals — even if they no longer pass filters), then the stalest passing ones.
 * Best-effort: a provider failure just leaves those prices to age (and be shown as aged / hidden).
 */
export async function refreshTrackedPrices(p: ReturnType<typeof providers>, chains: ChainId[], alreadyFresh: TokenSnapshot[]): Promise<TokenSnapshot[]> {
  const refresh = p.data.refresh?.bind(p.data);
  if (!refresh) return [];
  const fresh = new Set(alreadyFresh.map((s) => `${s.chain}:${s.address}`));
  const tokens = await collections.tokens();
  const [signalTokens, positionTokens] = await Promise.all([
    (await collections.signals()).distinct("tokenId", { status: "ACTIVE" }),
    (await collections.positions()).distinct("tokenId", { status: { $ne: "CLOSED" } }),
  ]);
  const exposed = [...new Set([...signalTokens, ...positionTokens])];
  const perChain = await Promise.all(
    chains.map(async (chain) => {
      const [priority, stale] = await Promise.all([
        exposed.length ? tokens.find({ chain, _id: { $in: exposed } }, { projection: { address: 1 } }).toArray() : Promise.resolve([]),
        tokens.find({ chain, passedFilters: true }, { projection: { address: 1 } }).sort({ lastScannedAt: 1 }).limit(REFRESH_PER_CHAIN + fresh.size).toArray(),
      ]);
      const addrs = [...new Set([...priority, ...stale].map((t) => t.address))].filter((a) => !fresh.has(`${chain}:${a}`)).slice(0, REFRESH_PER_CHAIN);
      if (!addrs.length) return [] as TokenSnapshot[];
      return withTimeout(refresh(chain, addrs), 12_000, `refresh(${chain})`).catch(() => [] as TokenSnapshot[]);
    }),
  );
  return perChain.flat();
}

export async function runScanCycle(opts: { chainsPerTick?: number } = {}): Promise<ScanResult> {
  const started = Date.now();
  const p = providers();
  await logEvent({ type: "SCANNER_STARTED", source: "scanner", level: "DEBUG", message: `Scan started (${p.data.name})` });
  try {
    const filters = await resolveScanFilters();
    const tick = await chainsForThisTick(filters.chains, opts.chainsPerTick ?? env().SCAN_CHAINS_PER_TICK);
    // Each chain is capped independently so one slow/misbehaving chain (a provider outage, a retry
    // cascade) contributes zero tokens for this tick instead of holding up every other chain's discovery
    // — and, transitively, the whole serverless request's 60s budget (see withTimeout's docstring).
    const discovered = (
      await Promise.all(
        tick.chains.map((c) =>
          withTimeout(p.data.discover(c), 20_000, `discover(${c})`).catch(async (err) => {
            await logEvent({ type: "PROVIDER_ERROR", source: "scanner", level: "WARN", message: `Discovery timed out or failed for ${c}: ${safeMessage(err)}` });
            return [] as TokenSnapshot[];
          }),
        ),
      )
    ).flat();
    // Discovery only re-reports a token while it sits on a trending/boost list, so a token we track that fell off one
    // kept its old price for hours — and that stale price is what the app showed (and what buys were judged against).
    const refreshed = await refreshTrackedPrices(p, tick.chains, discovered);
    const snaps = [...discovered, ...refreshed];
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
              lastAnalysisAttemptAt: null,
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
    const result: ScanResult = { discovered: discovered.length, newTokens, passed, filtered, durationMs: Date.now() - started };
    await logEvent({
      type: "SCANNER_COMPLETED",
      source: "scanner",
      level: "DEBUG",
      message: `Scanned ${discovered.length} tokens (+${refreshed.length} price refreshes) on ${tick.chains.join(", ")}: ${passed} passed filters, ${filtered} filtered`,
      data: { ...result, chains: tick.chains, chainsEnabled: tick.of },
    });
    await touchWorker("scanner-worker", null, { ...result, chains: tick.chains, chainsEnabled: tick.of });
    return result;
  } catch (err) {
    const msg = safeMessage(err);
    await logEvent({ type: "PROVIDER_ERROR", source: "scanner", level: "ERROR", message: `Scan failed: ${msg}` });
    await touchWorker("scanner-worker", msg);
    throw err;
  }
}
