import type { Prisma } from "@prisma/client";
import { DEFAULT_FILTERS } from "@/core/config";
import { providers } from "@/core/providers/registry";
import { applyFilters, mergeFilters } from "@/core/scanner/filter";
import type { ScannerFilters, TokenSnapshot } from "@/core/types";
import { db } from "@/lib/db";
import { logEvent, safeMessage } from "@/lib/events";
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

function tokenData(s: TokenSnapshot, passed: boolean): Prisma.TokenUncheckedUpdateInput {
  const tx1h = s.buys1h + s.sells1h;
  return {
    name: s.name,
    symbol: s.symbol,
    decimals: s.decimals || undefined,
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
  };
}

export async function runScanCycle(): Promise<ScanResult> {
  const started = Date.now();
  const p = providers();
  await logEvent({ type: "SCANNER_STARTED", source: "scanner", level: "DEBUG", message: `Scan started (${p.data.name})` });
  try {
    const filters = await resolveScanFilters();
    const snaps = (await Promise.all(filters.chains.map((c) => p.data.discover(c)))).flat();

    const existing = await db.token.findMany({
      where: { address: { in: snaps.map((s) => s.address) } },
      select: { id: true, address: true, chain: true, stage: true },
    });
    const byKey = new Map(existing.map((t) => [`${t.chain}:${t.address}`, t]));

    let newTokens = 0;
    let passed = 0;
    const metricRows: Prisma.TokenMetricCreateManyInput[] = [];
    const priceRows: Prisma.PriceSnapshotCreateManyInput[] = [];
    const volRows: Prisma.VolumeSnapshotCreateManyInput[] = [];
    const now = new Date();

    for (let i = 0; i < snaps.length; i += 25) {
      const chunk = snaps.slice(i, i + 25);
      const ops = chunk.map((s) => {
        const res = applyFilters(s, filters, now);
        if (res.passed) passed++;
        const prev = byKey.get(`${s.chain}:${s.address}`);
        if (!prev) newTokens++;
        const data = tokenData(s, res.passed);
        // keep pipeline stage monotonic for tokens already analysed; reset to FILTERED when they fall out of band
        const stage = !res.passed ? "FILTERED" : prev && prev.stage !== "FILTERED" && prev.stage !== "DISCOVERED" ? prev.stage : "SCANNED";
        return db.token.upsert({
          where: { chain_address: { chain: s.chain, address: s.address } },
          create: {
            ...(data as Prisma.TokenUncheckedCreateInput),
            chain: s.chain,
            address: s.address,
            name: s.name,
            symbol: s.symbol,
            decimals: s.decimals || 9,
            dex: s.dex,
            dataSource: s.dataSource,
            stage,
          },
          update: { ...data, stage },
          select: { id: true },
        });
      });
      const rows = await db.$transaction(ops);
      rows.forEach((r, idx) => {
        const s = chunk[idx];
        if (!applyFilters(s, filters, now).passed) return;
        metricRows.push({
          tokenId: r.id,
          priceUsd: s.priceUsd,
          marketCapUsd: s.marketCapUsd,
          fdvUsd: s.fdvUsd,
          liquidityUsd: s.liquidityUsd,
          volume5m: s.volume5m,
          volume15m: s.volume15m,
          volume30m: s.volume30m,
          volume1h: s.volume1h,
          volume24h: s.volume24h,
          buys5m: s.buys5m,
          sells5m: s.sells5m,
          buys1h: s.buys1h,
          sells1h: s.sells1h,
          holders: Math.max(0, s.holders),
          pairCount: s.pairCount,
        });
        priceRows.push({ tokenId: r.id, priceUsd: s.priceUsd, liquidityUsd: s.liquidityUsd });
        volRows.push({ tokenId: r.id, volume5m: s.volume5m, volume1h: s.volume1h, volume24h: s.volume24h, buys5m: s.buys5m, sells5m: s.sells5m });
      });
    }

    await Promise.all([
      db.tokenMetric.createMany({ data: metricRows }),
      db.priceSnapshot.createMany({ data: priceRows }),
      db.volumeSnapshot.createMany({ data: volRows }),
    ]);

    // pool records (one per token/pool)
    const tokenIds = new Map(
      (await db.token.findMany({ where: { address: { in: snaps.map((s) => s.address) } }, select: { id: true, address: true } })).map((t) => [t.address, t.id]),
    );
    for (const s of snaps) {
      const tokenId = tokenIds.get(s.address);
      if (!tokenId || !s.poolAddress) continue;
      await db.liquidityPool.upsert({
        where: { chain_address: { chain: s.chain, address: s.poolAddress } },
        create: { tokenId, chain: s.chain, address: s.poolAddress, dex: s.dex, liquidityUsd: s.liquidityUsd, createdAtChain: s.poolCreatedAt },
        update: { liquidityUsd: s.liquidityUsd },
      });
    }

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
