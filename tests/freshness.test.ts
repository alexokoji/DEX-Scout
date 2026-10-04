/**
 * Price freshness: tokens whose price hasn't been refreshed in 30 minutes (users saw 6h, 8h, 25 days) must not be
 * listed as current, can't be signalled, and a token page being opened refreshes its price first.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("next/headers", () => ({ cookies: async () => ({ get: () => undefined, set: () => {}, delete: () => {} }) }));

import { PRICE_MAX_AGE_MS } from "@/core/config";
import { closeDb, collections, newId } from "@/lib/db";
import type { TokenDoc } from "@/lib/models";

let dbUp = false;
try {
  await (await collections.users()).findOne({});
  dbUp = true;
} catch {
  dbUp = false;
}
afterAll(async () => {
  if (dbUp) await closeDb();
});

const MIN = 60_000;

(dbUp ? describe : describe.skip)("stale prices", () => {
  const ids: string[] = [];
  const signalIds: string[] = [];
  let template: TokenDoc;
  const CHAIN = "freshtest"; // isolates these rows from whatever else is in the shared dev database

  const mk = (name: string, ageMin: number, over: Partial<TokenDoc> = {}): TokenDoc => {
    const _id = newId();
    ids.push(_id);
    return { ...template, _id, chain: CHAIN as never, address: `0xfresh${name}${_id.replace(/-/g, "")}`.slice(0, 42), symbol: name.toUpperCase(), passedFilters: true, lastScannedAt: new Date(Date.now() - ageMin * MIN), ...over } as TokenDoc;
  };

  beforeAll(async () => {
    const { runScanCycle } = await import("@/services/scanner");
    const tokens = await collections.tokens();
    let t = await tokens.findOne({ chain: "solana" });
    if (!t) {
      await runScanCycle({ chainsPerTick: 0 });
      t = await tokens.findOne({ chain: "solana" });
    }
    if (!t) throw new Error("no template token");
    template = t;
  });

  afterEach(() => vi.restoreAllMocks());
  afterAll(async () => {
    await Promise.all([(await collections.tokens()).deleteMany({ _id: { $in: ids } }), (await collections.signals()).deleteMany({ _id: { $in: signalIds } })]).catch(() => {});
  });

  it("lists only tokens priced within 30 minutes, says how many were left out, and can show them on request", async () => {
    const { listTokens, tokenQuerySchema } = await import("@/services/queries");
    const fresh = mk("fresha", 1);
    const aging = mk("agingb", 25);
    const old1 = mk("oldc", 6 * 60);
    const old2 = mk("oldd", 25 * 24 * 60);
    await (await collections.tokens()).insertMany([fresh, aging, old1, old2]);

    const q = (extra: object = {}) => tokenQuerySchema.parse({ chain: CHAIN, pageSize: 50, ...extra });
    const def = await listTokens(q());
    const syms = def.rows.map((r) => r.symbol).sort();
    expect(syms).toEqual(["AGINGB", "FRESHA"]); // 25 min is still within the limit; 6 h and 25 days are not
    expect(def.staleHidden).toBe(2);
    expect(def.total).toBe(2);

    const all = await listTokens(q({ stale: "true" }));
    expect(all.rows).toHaveLength(4);
    expect(all.staleHidden).toBe(0);

    // the hidden count respects the other filters
    expect((await listTokens(q({ passing: "true", minMcap: 1e15 }))).staleHidden).toBe(0);
    expect(PRICE_MAX_AGE_MS).toBe(30 * MIN);
  });

  it("opening a stale token refreshes its price first; a fresh one costs no request; a failing provider keeps the old price and its real age", async () => {
    const { providers } = await import("@/core/providers/registry");
    const { refreshTokenIfStale } = await import("@/services/tokenPrice");
    const tokens = await collections.tokens();
    const stale = mk("stale", 6 * 60, { priceUsd: 0.0055 });
    await tokens.insertOne(stale);
    const snap = { ...stale, priceUsd: 0.007, volume24h: 5, volume1h: 1, buys1h: 3, sells1h: 1, change5m: 2, change1h: 4, change24h: 6, observedAt: new Date() } as never;
    const refresh = vi.fn(async () => [snap]);
    const dataProvider = providers().data as unknown as { refresh?: unknown };
    dataProvider.refresh = refresh;
    try {
      const asRef = { id: stale._id, chain: stale.chain, address: stale.address, lastScannedAt: stale.lastScannedAt };
      expect(await refreshTokenIfStale(asRef)).toBe(true);
      const row = await tokens.findOne({ _id: stale._id });
      expect(row?.priceUsd).toBe(0.007);
      expect(Date.now() - row!.lastScannedAt.getTime()).toBeLessThan(10_000);
      expect(refresh).toHaveBeenCalledTimes(1);

      // now fresh: no second request
      expect(await refreshTokenIfStale({ ...asRef, lastScannedAt: row!.lastScannedAt })).toBe(false);
      expect(refresh).toHaveBeenCalledTimes(1);

      // provider down: keep what we have, report not refreshed (the UI then shows the true age in red)
      await tokens.updateOne({ _id: stale._id }, { $set: { lastScannedAt: new Date(Date.now() - 6 * 60 * MIN) } });
      dataProvider.refresh = vi.fn(async () => { throw new Error("DexScreener down"); });
      expect(await refreshTokenIfStale({ ...asRef, lastScannedAt: new Date(Date.now() - 6 * 60 * MIN) })).toBe(false);
      expect((await tokens.findOne({ _id: stale._id }))?.priceUsd).toBe(0.007);
      // an empty / zero-price answer must never overwrite a price
      dataProvider.refresh = vi.fn(async () => [{ ...(snap as object), priceUsd: 0 }]);
      expect(await refreshTokenIfStale({ ...asRef, lastScannedAt: new Date(Date.now() - 6 * 60 * MIN) })).toBe(false);
      expect((await tokens.findOne({ _id: stale._id }))?.priceUsd).toBe(0.007);
    } finally {
      delete dataProvider.refresh;
    }
  });

  it("the signal cycle closes active signals whose token went stale or stopped passing, and leaves healthy ones", async () => {
    const { runSignalCycle } = await import("@/services/signals");
    const tokens = await collections.tokens();
    const signals = await collections.signals();
    const staleTok = mk("sigstale", 3 * 60, { stage: "SIGNAL_GENERATED" });
    const failing = mk("sigfail", 1, { stage: "SIGNAL_GENERATED", passedFilters: false });
    const healthy = mk("sighealthy", 1, { stage: "SIGNAL_GENERATED" });
    await tokens.insertMany([staleTok, failing, healthy]);
    const now = new Date();
    const sig = async (tokenId: string) => {
      const _id = newId();
      signalIds.push(_id);
      await signals.insertOne({ _id, tokenId, type: "WATCH", status: "ACTIVE", dataSource: "MOCK", score: 60, opportunityScore: 60, riskLevel: "MODERATE", priceUsd: 1, entryMin: 1, entryMax: 1, target1: 2, target2: 3, target3: 4, reasons: [], warnings: [], createdAt: now, updatedAt: now, expiresAt: new Date(Date.now() + 3_600_000), analysis: null } as never);
      return _id;
    };
    const [a, b, c] = [await sig(staleTok._id), await sig(failing._id), await sig(healthy._id)];
    await runSignalCycle();
    const status = async (id: string) => (await signals.findOne({ _id: id }))?.status;
    expect(await status(a)).toBe("EXPIRED");
    expect(await status(b)).toBe("EXPIRED");
    // `healthy` has no analysis stored, so the cycle can't re-evaluate it, but it is fresh and passing: it must not be closed here
    expect(await status(c)).toBe("ACTIVE");
  });

  it("scan refresh puts open positions and active signals first, even for tokens that no longer pass filters", async () => {
    const { refreshTrackedPrices } = await import("@/services/scanner");
    const tokens = await collections.tokens();
    const positions = await collections.positions();
    const held = mk("held", 2 * 24 * 60, { passedFilters: false }); // not passing, very old, but someone holds it
    const others = Array.from({ length: 160 }, (_, i) => mk(`other${i}`, 60 + i)); // more passing tokens than one tick can refresh
    await tokens.insertMany([held, ...others]);
    const posId = newId();
    await positions.insertOne({ _id: posId, userId: "freshtest-user", accountId: "a", tokenId: held._id, environment: "LIVE", status: "OPEN", health: "HEALTHY", healthNotes: null, origin: "MANUAL", sourceSignalId: null, entryPriceUsd: 1, currentPriceUsd: 1, initialAmount: 1, amount: 1, investedUsd: 1, costBasisUsd: 1, realizedPnlUsd: 0, targetsHit: 0, targetsSnapshot: [], emergencyEnabled: false, emergencyAutoExit: false, openedAt: new Date(), updatedAt: new Date(), closedAt: null, lastAnalysisAt: null } as never);
    try {
      const refresh = vi.fn(async (_c: string, addrs: string[]) => addrs.map((a) => ({ chain: CHAIN, address: a }) as never));
      await refreshTrackedPrices({ data: { refresh } } as never, [CHAIN as never], []);
      const asked = refresh.mock.calls[0][1];
      expect(asked[0]).toBe(held.address);
      expect(asked.length).toBeLessThanOrEqual(150);
    } finally {
      await positions.deleteOne({ _id: posId });
    }
  });
});
