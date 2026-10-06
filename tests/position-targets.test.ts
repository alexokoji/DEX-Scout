/**
 * "Each position should have its own target, not a universal one: 8% for position 1 and 20% for position 2." The engine already worked
 * from each position's own ladder; these pin that a position can be given one (when it is bought, or afterwards), that two positions
 * really do act on different targets at the same price, and the rules around changing one.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("next/headers", () => ({ cookies: async () => ({ get: () => undefined, set: () => {}, delete: () => {} }) }));
vi.mock("@/lib/env", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/env")>()), liveTradingAllowed: () => true }));

import { projectRise } from "@/core/analysis/projection";
import { evaluateTargets } from "@/core/trading/targets";
import { providers } from "@/core/providers/registry";
import { generateSignal } from "@/core/signals/engine";
import type { Candle } from "@/core/types";
import { closeDb, collections, newId } from "@/lib/db";
import type { AutoSellOrderDoc, PositionDoc, TokenDoc, TradeDoc } from "@/lib/models";
import { toLadder } from "@/services/positionTargets";
import { analysisFor } from "./helpers";

describe("two positions, two ladders, one price", () => {
  const entry = 1;
  const pos = (initialAmount: number) => ({ entryPriceUsd: entry, initialAmount, amount: initialAmount, costBasisUsd: initialAmount, targetsHit: 0 });
  it("at +12%, the position aiming at +8% sells and the one aiming at +20% does not", () => {
    const one = evaluateTargets(pos(1000), 1.12, [{ level: 1, gainPct: 8, sellPct: 100 }]);
    const two = evaluateTargets(pos(500), 1.12, [{ level: 1, gainPct: 20, sellPct: 100 }]);
    expect(one).toEqual([{ level: 1, gainPct: 8, sellAmount: 1000, isFinal: true }]);
    expect(two).toEqual([]);
    expect(evaluateTargets(pos(500), 1.21, [{ level: 1, gainPct: 20, sellPct: 100 }])).toHaveLength(1);
  });
});

describe("a ladder as people type it", () => {
  it("is numbered in ascending order of gain, whatever order it was typed in", () => {
    expect(toLadder([{ gainPct: 30, sellPct: 50 }, { gainPct: 10, sellPct: 25 }])).toEqual([{ level: 1, gainPct: 10, sellPct: 25 }, { level: 2, gainPct: 30, sellPct: 50 }]);
  });
  it("is refused with the reason when it makes no sense: equal gains, a share over 100%, nothing", () => {
    expect(() => toLadder([{ gainPct: 10, sellPct: 25 }, { gainPct: 10, sellPct: 25 }])).toThrow(/increase/);
    expect(() => toLadder([])).toThrow(/At least one/);
    expect(() => toLadder([{ gainPct: 10, sellPct: 150 }])).toThrow(/between 0 and 100/);
    try {
      toLadder([{ gainPct: 5, sellPct: 10 }, { gainPct: 5, sellPct: 10 }]);
    } catch (e) {
      expect(e).toMatchObject({ status: 422, violations: [expect.stringMatching(/increase/)] });
    }
  });
});

describe("signal targets are drawn from the token's own history, never the same three percentages for everyone", () => {
  const steady = (n: number, pct: number): Candle[] => Array.from({ length: n }, (_, i) => {
    const close = 1 * (1 + pct / 100) ** i;
    return { time: 1_700_000_000 + i * 300, open: close, high: close, low: close, close, volume: 1000, buys: 5, sells: 5 };
  });
  it("different tokens get different targets, and with no history there are none (null), not invented ones", () => {
    const a = analysisFor(3);
    const withHistory = (pct: number) => ({ ...a, projection: projectRise(steady(120, pct), 5, [60, 240]) });
    const slow = generateSignal({ ...withHistory(0.05), opportunity: { ...a.opportunity, score: 95 } });
    const fast = generateSignal({ ...withHistory(0.4), opportunity: { ...a.opportunity, score: 95 } });
    expect(slow).not.toBeNull();
    expect(fast).not.toBeNull();
    const up = (s: { target1: number | null }, price: number) => (s!.target1! / price - 1) * 100;
    expect(up(fast!, a.snapshot.priceUsd)).toBeGreaterThan(up(slow!, a.snapshot.priceUsd)); // a faster-moving token has a higher first target
    const none = generateSignal({ ...a, projection: null, opportunity: { ...a.opportunity, score: 95 } });
    expect(none).not.toBeNull();
    expect([none!.target1, none!.target2, none!.target3]).toEqual([null, null, null]);
  });
});

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

(dbUp ? describe : describe.skip)("giving a position its own targets", () => {
  const userId = newId();
  const WALLET = "W".repeat(44);
  const ids = { tokens: [] as string[], positions: [] as string[], trades: [] as string[] };
  let template: TokenDoc;
  let accountId = "";

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
    template = t;
    accountId = newId();
    const now = new Date();
    await (await collections.users()).insertOne({ _id: userId, email: `targets-${Date.now()}@test.local`, passwordHash: "x", name: null, role: "USER", createdAt: now });
    await (await collections.tradingAccounts()).insertOne({ _id: accountId, userId, environment: "LIVE", realizedPnlUsd: 0, createdAt: now });
    await (await collections.wallets()).insertOne({ _id: newId(), userId, chain: "solana", address: WALLET, label: null, verifiedAt: now, createdAt: now });
    await getSettings(userId);
    await (await collections.tradingSettings()).updateOne({ userId }, { $set: { minOpportunityScore: 0, minLiquidityUsd: 0, minVolume24hUsd: 0, maxPriceImpactPct: 50, maxAllowedRisk: "HIGH", minTrust: "UNPROVEN" } });
  });
  afterEach(() => vi.restoreAllMocks());
  afterAll(async () => {
    await Promise.all([
      (await collections.users()).deleteOne({ _id: userId }), (await collections.tradingAccounts()).deleteMany({ userId }), (await collections.wallets()).deleteMany({ userId }),
      (await collections.tradingSettings()).deleteMany({ userId }), (await collections.positions()).deleteMany({ userId }), (await collections.trades()).deleteMany({ userId }),
      (await collections.autoSellOrders()).deleteMany({ userId }), (await collections.tokens()).deleteMany({ _id: { $in: ids.tokens } }),
    ]).catch(() => {});
  });

  async function openPosition(over: Partial<PositionDoc> = {}) {
    const token = { ...template, _id: newId(), address: `Tgt${newId().replace(/-/g, "")}`.slice(0, 44), symbol: "TGT" } as TokenDoc;
    ids.tokens.push(token._id);
    await (await collections.tokens()).insertOne(token);
    const now = new Date();
    const p = {
      _id: newId(), userId, accountId, tokenId: token._id, environment: "LIVE", status: "OPEN", health: "HOLD", healthNotes: null, origin: "MANUAL", sourceSignalId: null,
      entryPriceUsd: 0.01, currentPriceUsd: 0.01, initialAmount: 1000, amount: 1000, investedUsd: 10, costBasisUsd: 10, realizedPnlUsd: 0, targetsHit: 0, walletAddress: WALLET,
      targetsSnapshot: [{ level: 1, gainPct: 8, sellPct: 50 }, { level: 2, gainPct: 15, sellPct: 100 }], emergencyEnabled: false, emergencyAutoExit: false, openedAt: now, updatedAt: now, closedAt: null, lastAnalysisAt: null, ...over,
    } as PositionDoc;
    ids.positions.push(p._id);
    await (await collections.positions()).insertOne(p);
    return p;
  }
  const load = async (id: string) => (await collections.positions()).findOne({ _id: id });

  it("position 1 gets 8% and position 2 gets 20%, and each keeps its own", async () => {
    const { setPositionTargets } = await import("@/services/positionTargets");
    const a = await openPosition();
    const b = await openPosition();
    await setPositionTargets(userId, a._id, [{ gainPct: 8, sellPct: 100 }]);
    await setPositionTargets(userId, b._id, [{ gainPct: 20, sellPct: 100 }]);
    expect((await load(a._id))?.targetsSnapshot).toEqual([{ level: 1, gainPct: 8, sellPct: 100 }]);
    expect((await load(b._id))?.targetsSnapshot).toEqual([{ level: 1, gainPct: 20, sellPct: 100 }]);
  });

  it("re-plans what is left from now: back to the first target, shares of what is held, entry price unchanged, and the change is on the record", async () => {
    const { setPositionTargets } = await import("@/services/positionTargets");
    // 400 of 1000 tokens already sold at the first target
    const p = await openPosition({ amount: 600, targetsHit: 1, status: "TARGET_1", realizedPnlUsd: 1.5 });
    await setPositionTargets(userId, p._id, [{ gainPct: 12, sellPct: 50 }, { gainPct: 30, sellPct: 100 }]);
    const after = await load(p._id);
    expect(after).toMatchObject({ amount: 600, initialAmount: 600, targetsHit: 0, entryPriceUsd: 0.01, realizedPnlUsd: 1.5 });
    expect(after?.status).not.toBe("TARGET_1");
    // the new first target sells half of what is held now
    expect(evaluateTargets({ entryPriceUsd: after!.entryPriceUsd, initialAmount: after!.initialAmount, amount: after!.amount, costBasisUsd: after!.costBasisUsd, targetsHit: after!.targetsHit }, 0.01 * 1.13, after!.targetsSnapshot)).toEqual([{ level: 1, gainPct: 12, sellAmount: 300, isFinal: false }]);
    const ev = await (await collections.positionEvents()).findOne({ positionId: p._id, type: "TARGETS_CHANGED" });
    expect(ev?.message).toMatch(/Before: \+8% sells 50%.*Now: \+12% sells 50%, \+30% sells 100%/);
  });

  it("is refused while auto-sell is armed (its orders sit with the venue at the old targets), and allowed again once it is cancelled; suggestions are simply rebuilt", async () => {
    const { setPositionTargets } = await import("@/services/positionTargets");
    const p = await openPosition();
    const orders = await collections.autoSellOrders();
    const doc = (status: AutoSellOrderDoc["status"]) => ({ _id: newId(), userId, positionId: p._id, tokenId: p.tokenId, chain: "solana", venue: "jupiter", levels: [1], gainPct: 8, targetPriceUsd: 0.0108, sellAmount: 500, sellAmountRaw: "500", minBuyRaw: "1", status, maker: WALLET, orderRef: null, validTo: null, bookedSellRaw: "0", bookedBuyRaw: "0", txHashes: [], error: null, createdAt: new Date(), activatedAt: null, updatedAt: new Date(), lastSyncAt: null }) as unknown as AutoSellOrderDoc;
    const armed = doc("ACTIVE");
    const suggested = doc("SUGGESTED");
    await orders.insertMany([armed, suggested]);
    await expect(setPositionTargets(userId, p._id, [{ gainPct: 25, sellPct: 100 }])).rejects.toMatchObject({ status: 409, message: expect.stringMatching(/Cancel auto-sell first/) });
    expect((await load(p._id))?.targetsSnapshot).toHaveLength(2); // untouched
    await orders.updateOne({ _id: armed._id }, { $set: { status: "CANCELLED" } });
    await setPositionTargets(userId, p._id, [{ gainPct: 25, sellPct: 100 }]);
    expect((await load(p._id))?.targetsSnapshot).toEqual([{ level: 1, gainPct: 25, sellPct: 100 }]);
    expect(await orders.countDocuments({ _id: suggested._id })).toBe(0); // built from the old ladder: discarded, rebuilt when armed
  });

  it("only changes the user's own open positions, and rejects a nonsense ladder before touching anything", async () => {
    const { setPositionTargets } = await import("@/services/positionTargets");
    const p = await openPosition();
    await expect(setPositionTargets(newId(), p._id, [{ gainPct: 10, sellPct: 100 }])).rejects.toMatchObject({ status: 404 }); // someone else's
    const closed = await openPosition({ status: "CLOSED", amount: 0 });
    await expect(setPositionTargets(userId, closed._id, [{ gainPct: 10, sellPct: 100 }])).rejects.toMatchObject({ status: 404 });
    await expect(setPositionTargets(userId, p._id, [{ gainPct: 10, sellPct: 50 }, { gainPct: 10, sellPct: 50 }])).rejects.toMatchObject({ status: 422 });
    expect((await load(p._id))?.targetsSnapshot).toHaveLength(2);
  });

  it("an account from before this keeps its one ladder as the default for new positions (settings v6)", async () => {
    const { getSettings, defaultSettingsDoc, SETTINGS_VERSION } = await import("@/services/settings");
    const col = await collections.tradingSettings();
    const u = newId();
    const legacy = defaultSettingsDoc(u) as unknown as Record<string, unknown>;
    delete legacy.targetsSource;
    legacy.settingsVersion = 5;
    try {
      await col.insertOne(legacy as never);
      const s = await getSettings(u);
      expect(s.targetsSource).toBe("FIXED");
      expect((await col.findOne({ userId: u }))?.settingsVersion).toBe(SETTINGS_VERSION);
    } finally {
      await col.deleteMany({ userId: u });
    }
  });
  describe("at the buy", () => {
    const input = (tokenAddress: string) => ({ chain: "solana" as const, tokenAddress, amountUsd: 5, slippageBps: 100, environment: "LIVE" as const, acknowledgeTrust: true });

    /** a prepared buy, settled on-chain: the position it opens */
    async function boughtWith(over: { targets?: { gainPct: number; sellPct: number }[]; auto?: boolean } = {}) {
      const { prepareTrade, reconcileLiveTrade } = await import("@/services/trading");
      vi.spyOn(providers().dex, "buildSwapTransaction").mockResolvedValue({ unsignedTxBase64: "unsigned" });
      const prepared = await prepareTrade(userId, { ...input(template.address), ...(over.targets ? { targets: over.targets } : {}) }, over.auto ? "AUTO_ENTRY" : "MANUAL_ENTRY");
      const trades = await collections.trades();
      ids.trades.push(prepared.trade.id);
      await trades.updateOne({ _id: prepared.trade.id }, { $set: { status: "PENDING", "transaction.signature": "5" + newId().replace(/-/g, "").padEnd(80, "f"), "transaction.submittedAt": new Date() } });
      vi.spyOn(providers().dex, "getTransactionStatus").mockResolvedValue({ status: "CONFIRMED", slot: 1 });
      await reconcileLiveTrade(prepared.trade.id);
      const trade = (await trades.findOne({ _id: prepared.trade.id })) as TradeDoc;
      const position = (await collections.positions()).findOne({ _id: trade.positionId! });
      return { trade, position: (await position)! };
    }

    it("targets typed for this buy are stored with the trade and become the position's own", async () => {
      const { trade, position } = await boughtWith({ targets: [{ gainPct: 20, sellPct: 100 }] });
      expect((trade.quote as { targets?: unknown }).targets).toEqual([{ level: 1, gainPct: 20, sellPct: 100 }]);
      expect(position.targetsSnapshot).toEqual([{ level: 1, gainPct: 20, sellPct: 100 }]);
    });
    it("without any, the position starts from the user's default ladder", async () => {
      const { getSettings } = await import("@/services/settings");
      const { position } = await boughtWith();
      expect(position.targetsSnapshot).toEqual((await getSettings(userId)).targets);
    });
    it("a nonsense ladder is refused at the buy, before anything is prepared", async () => {
      const { prepareTrade } = await import("@/services/trading");
      vi.spyOn(providers().dex, "buildSwapTransaction").mockResolvedValue({ unsignedTxBase64: "unsigned" });
      await expect(prepareTrade(userId, { ...input(template.address), targets: [{ gainPct: 10, sellPct: 100 }, { gainPct: 5, sellPct: 100 }] }, "MANUAL_ENTRY")).resolves.toBeDefined(); // order is normalised, so this one is valid
      await expect(prepareTrade(userId, { ...input(template.address), targets: [{ gainPct: 10, sellPct: 100 }, { gainPct: 10, sellPct: 100 }] }, "MANUAL_ENTRY")).rejects.toMatchObject({ status: 422 });
    });
    it("the bot, if the user chose it, draws each position's targets from that token's own history; otherwise it uses the default ladder", async () => {
      const { getSettings } = await import("@/services/settings");
      const { resetProjectionCache } = await import("@/services/projection");
      const steady: Candle[] = Array.from({ length: 400 }, (_, i) => {
        const close = 1.01 ** i; // climbing 1% every 15 minutes
        return { time: 1_700_000_000 + i * 900, open: close, high: close, low: close, close, volume: 1000, buys: 5, sells: 5 };
      });
      vi.spyOn(providers().data, "getCandles").mockResolvedValue(steady);
      resetProjectionCache();
      const settings = await getSettings(userId);
      await (await collections.tradingSettings()).updateOne({ userId }, { $set: { targetsSource: "PROJECTED" } });
      try {
        const { position } = await boughtWith({ auto: true });
        const gains = position.targetsSnapshot.map((t) => t.gainPct);
        expect(position.targetsSnapshot).toHaveLength(settings.targets.length);
        expect(position.targetsSnapshot.map((t) => t.sellPct)).toEqual(settings.targets.map((t) => t.sellPct)); // the user's shares, the token's gains
        expect(gains).not.toEqual(settings.targets.map((t) => t.gainPct));
        for (let i = 1; i < gains.length; i++) expect(gains[i]).toBeGreaterThan(gains[i - 1]);
        // and with too little history to draw from, it falls back to the user's ladder instead of inventing one
        vi.spyOn(providers().data, "getCandles").mockResolvedValue(steady.slice(0, 10));
        resetProjectionCache();
        const fallback = await boughtWith({ auto: true });
        expect(fallback.position.targetsSnapshot).toEqual(settings.targets);
      } finally {
        await (await collections.tradingSettings()).updateOne({ userId }, { $set: { targetsSource: "FIXED" } });
      }
    });
  });
});
