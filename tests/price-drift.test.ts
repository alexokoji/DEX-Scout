/**
 * "I saw 0.0055 and bought at 0.007": the listed price had gone stale and nothing compared it with what the swap would
 * actually fill at. Covers the drift maths, the warnings/blocks built on it, and the price refresh that keeps listed
 * prices current in the first place.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("next/headers", () => ({ cookies: async () => ({ get: () => undefined, set: () => {}, delete: () => {} }) }));
vi.mock("@/lib/env", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/env")>()), liveTradingAllowed: () => true }));

import { DexScreenerDataProvider } from "@/core/providers/dexscreener";
import { closeDb, collections, newId } from "@/lib/db";
import type { TokenDoc } from "@/lib/models";
import { priceDrift } from "@/services/trading";

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

describe("priceDrift", () => {
  const now = Date.parse("2026-10-04T12:00:00Z");
  it("flags the reported case: listed 0.0055, fills at 0.007", () => {
    const d = priceDrift(0.0055, 0.007, new Date(now - 47 * 60_000), now);
    expect(d.driftPct).toBeCloseTo(27.27, 1);
    expect(d.listedAgeSec).toBe(47 * 60);
    expect(d.warning).toContain("$0.00550");
    expect(d.warning).toContain("47 min old");
    expect(d.warning).toContain("$0.00700");
    expect(d.warning).toContain("+27%");
  });
  it("stays quiet for ordinary spread and flags a drop too", () => {
    expect(priceDrift(1, 1.03, new Date(now), now).warning).toBeNull();
    expect(priceDrift(1, 0.9, new Date(now), now).warning).toContain("-10%");
  });
  it("handles missing or zero prices without NaN", () => {
    expect(priceDrift(0, 5, null, now)).toMatchObject({ driftPct: 0, warning: null, listedAgeSec: null });
    expect(priceDrift(5, 0, undefined, now).driftPct).toBe(0);
  });
});

describe("price refresh request shape", () => {
  afterEach(() => vi.restoreAllMocks());
  it("asks DexScreener for tracked tokens 30 at a time", async () => {
    const calls: string[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (url) => {
      calls.push(String(url));
      return new Response("[]", { status: 200, headers: { "content-type": "application/json" } });
    });
    const addrs = Array.from({ length: 65 }, (_, i) => `0x${i.toString(16).padStart(40, "0")}`);
    const out = await new DexScreenerDataProvider({ svm: async () => { throw new Error("n/a"); }, evm: async () => { throw new Error("n/a"); } }).refresh("base", addrs);
    expect(out).toEqual([]);
    expect(calls).toHaveLength(3);
    expect(calls.every((c) => c.includes("/tokens/v1/base/"))).toBe(true);
    expect(calls.map((c) => c.split("/tokens/v1/base/")[1].split(",").length).sort((a, b) => a - b)).toEqual([5, 30, 30]);
  });
});

(dbUp ? describe : describe.skip)("stale prices are refreshed, and bad entries are caught", () => {
  const userId = newId();
  let token: TokenDoc;
  const tokenIds: string[] = [];

  beforeAll(async () => {
    const { runScanCycle } = await import("@/services/scanner");
    const { runAnalysisCycle } = await import("@/services/analysis");
    const { getSettings } = await import("@/services/settings");
    const tokens = await collections.tokens();
    const find = () => tokens.findOne({ passedFilters: true, analysis: { $ne: null }, chain: "solana" }, { sort: { liquidityUsd: -1 } });
    let t = await find();
    if (!t) {
      await runScanCycle({ chainsPerTick: 0 });
      await runAnalysisCycle(8);
      t = await find();
    }
    if (!t) throw new Error("no analysed mock token available");
    token = t;
    const now = new Date();
    await (await collections.users()).insertOne({ _id: userId, email: `drift-${Date.now()}@test.local`, passwordHash: "x", name: null, role: "USER", createdAt: now });
    await (await collections.tradingAccounts()).insertOne({ _id: newId(), userId, environment: "LIVE", realizedPnlUsd: 0, createdAt: now });
    await (await collections.wallets()).insertOne({ _id: newId(), userId, chain: "solana", address: "W".repeat(44), label: null, verifiedAt: now, createdAt: now });
    await getSettings(userId);
    await (await collections.tradingSettings()).updateOne({ userId }, { $set: { minOpportunityScore: 0, minLiquidityUsd: 0, minVolume24hUsd: 0, maxPriceImpactPct: 50, maxAllowedRisk: "HIGH", minTrust: "UNPROVEN" } });
  });

  afterEach(() => vi.restoreAllMocks());
  afterAll(async () => {
    await Promise.all([
      (await collections.users()).deleteOne({ _id: userId }), (await collections.tradingAccounts()).deleteMany({ userId }), (await collections.wallets()).deleteMany({ userId }),
      (await collections.tradingSettings()).deleteMany({ userId }), (await collections.trades()).deleteMany({ userId }), (await collections.tokens()).deleteMany({ _id: { $in: tokenIds } }),
    ]).catch(() => {});
  });

  /** a live quote that would fill `pct`% above the listed price */
  async function quoteAbove(pct: number) {
    // a quote now also refreshes the stored price, so put the listed price back where each test expects it
    await (await collections.tokens()).updateOne({ _id: token._id }, { $set: { priceUsd: token.priceUsd, lastScannedAt: new Date() } });
    const { providers } = await import("@/core/providers/registry");
    const real = providers().dex.getQuote.bind(providers().dex);
    vi.spyOn(providers().dex, "getQuote").mockImplementation(async (req) => {
      const q = await real(req);
      return { ...q, effectivePriceUsd: token.priceUsd * (1 + pct / 100), priceImpactPct: 0.3 };
    });
    vi.spyOn(providers().dex, "buildSwapTransaction").mockResolvedValue({ unsignedTxBase64: "unsigned" });
  }
  const input = () => ({ chain: "solana" as const, tokenAddress: token.address, amountUsd: 5, slippageBps: 100, environment: "LIVE" as const, acknowledgeTrust: true });

  it("refreshTrackedPrices re-fetches the stalest passing tokens, skips ones just discovered, and tolerates a failing provider", async () => {
    const { refreshTrackedPrices } = await import("@/services/scanner");
    const tokens = await collections.tokens();
    const mk = (i: number, ageMin: number, passed = true): TokenDoc => ({ ...token, _id: newId(), address: `0xdrift${i}${newId().replace(/-/g, "")}`.slice(0, 42), chain: "xtest", passedFilters: passed, lastScannedAt: new Date(Date.now() - ageMin * 60_000) } as TokenDoc);
    const docs = [mk(1, 300), mk(2, 120), mk(3, 5), mk(4, 999, false)];
    tokenIds.push(...docs.map((d) => d._id));
    await tokens.insertMany(docs);

    const refresh = vi.fn(async (_c: string, addrs: string[]) => addrs.map((a) => ({ chain: "xtest", address: a }) as never));
    const out = await refreshTrackedPrices({ data: { refresh } } as never, ["xtest" as never], [{ chain: "xtest", address: docs[2].address } as never]);
    const asked = refresh.mock.calls[0][1];
    expect(asked.indexOf(docs[0].address)).toBeGreaterThanOrEqual(0);
    expect(asked.indexOf(docs[0].address)).toBeLessThan(asked.indexOf(docs[1].address)); // stalest first
    expect(asked).not.toContain(docs[2].address); // discovered this tick already
    expect(asked).not.toContain(docs[3].address); // not passing filters: not worth a request
    expect(out.length).toBe(asked.length);

    const failing = vi.fn(async () => { throw new Error("DexScreener down"); });
    await expect(refreshTrackedPrices({ data: { refresh: failing } } as never, ["xtest" as never], [])).resolves.toEqual([]);
    await expect(refreshTrackedPrices({ data: {} } as never, ["xtest" as never], [])).resolves.toEqual([]); // provider without refresh support
  });

  it("a manual buy that would fill well above the listed price gets a warning but is not blocked", async () => {
    const { quoteTrade } = await import("@/services/trading");
    await quoteAbove(27);
    const r = await quoteTrade(userId, input(), false);
    expect(r.pricing.driftPct).toBeCloseTo(27, 0);
    expect(r.warnings.join(" ")).toMatch(/no longer matches the market/);
    expect(r.violations.join(" ")).not.toMatch(/chasing/);
  });

  it("the bot refuses to chase: the same drift blocks an automatic entry, a small one does not", async () => {
    const { prepareTrade } = await import("@/services/trading");
    await quoteAbove(27);
    await expect(prepareTrade(userId, input(), "AUTO_ENTRY")).rejects.toMatchObject({ status: 422, violations: [expect.stringMatching(/not chasing/)] });
    vi.restoreAllMocks();
    await quoteAbove(2);
    const ok = await prepareTrade(userId, input(), "AUTO_ENTRY");
    expect(ok.trade.status).toBe("PREPARED");
  });

  it("'Review & sign' refuses a queued buy whose price has run away since it was queued", async () => {
    const { refreshPreparedTrade, prepareTrade } = await import("@/services/trading");
    await quoteAbove(0);
    const queued = await prepareTrade(userId, input(), "AUTO_ENTRY");
    vi.restoreAllMocks();
    await quoteAbove(0);
    // pretend it was queued at 70% of today's price: the market is now ~43% above what was approved
    await (await collections.trades()).updateOne({ _id: queued.trade.id }, { $set: { priceUsd: token.priceUsd * 0.7 } });
    await expect(refreshPreparedTrade(userId, queued.trade.id)).rejects.toMatchObject({ status: 422, violations: [expect.stringMatching(/Queued at .* now .*\+4\d%/)] });
    // and an unmoved one refreshes fine
    await (await collections.trades()).updateOne({ _id: queued.trade.id }, { $set: { priceUsd: token.priceUsd } });
    await expect(refreshPreparedTrade(userId, queued.trade.id)).resolves.toMatchObject({ unsignedTxBase64: "unsigned" });
  });
});
