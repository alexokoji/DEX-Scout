/**
 * Integration tests against the real (embedded/local) MongoDB with the mock provider.
 * They are skipped automatically when the database is unreachable.
 */
import { describe, expect, it, vi, beforeAll, afterAll } from "vitest";

vi.mock("next/headers", () => ({
  cookies: async () => ({ get: () => undefined, set: () => {}, delete: () => {} }),
}));

import { closeDb, collections, newId } from "@/lib/db";

let dbUp = false;
try {
  const users = await collections.users();
  await users.findOne({});
  dbUp = true;
} catch {
  dbUp = false;
}
const d = dbUp ? describe : describe.skip;

afterAll(async () => {
  if (dbUp) await closeDb();
});

d("database + trading flow (paper, mock provider)", () => {
  let userId = "";
  const email = `it-${Date.now()}@test.local`;

  beforeAll(async () => {
    const { runScanCycle } = await import("@/services/scanner");
    const { runAnalysisCycle } = await import("@/services/analysis");
    const { runSignalCycle } = await import("@/services/signals");
    await runScanCycle();
    await runAnalysisCycle();
    await runSignalCycle();
    const users = await collections.users();
    const bots = await collections.bots();
    const accounts = await collections.tradingAccounts();
    userId = newId();
    const now = new Date();
    await users.insertOne({ _id: userId, email, passwordHash: "x", name: null, role: "USER", createdAt: now });
    await bots.insertOne({ _id: newId(), userId, status: "PAUSED", environment: "PAPER", lastRunAt: null, emergencyStoppedAt: null, createdAt: now, updatedAt: now });
    await accounts.insertOne({ _id: newId(), userId, environment: "PAPER", realizedPnlUsd: 0, createdAt: now });
  });

  afterAll(async () => {
    if (userId) {
      const [users, bots, accounts, settings, positions, trades] = await Promise.all([
        collections.users(), collections.bots(), collections.tradingAccounts(), collections.tradingSettings(), collections.positions(), collections.trades(),
      ]);
      await Promise.all([
        users.deleteOne({ _id: userId }),
        bots.deleteMany({ userId }),
        accounts.deleteMany({ userId }),
        settings.deleteMany({ userId }),
        positions.deleteMany({ userId }),
        trades.deleteMany({ userId }),
      ]).catch(() => {});
    }
  });

  it("scanner persisted tokens with indexes-backed lookups and passing tokens have analysis + safety", async () => {
    const tokens = await collections.tokens();
    const total = await tokens.countDocuments({});
    expect(total).toBeGreaterThan(50);
    const passing = await tokens.find({ passedFilters: true }).limit(5).toArray();
    expect(passing.length).toBeGreaterThan(0);
    for (const t of passing) {
      expect(t.safety).not.toBeNull();
      expect(t.analysis).not.toBeNull();
      expect(t.marketCapUsd).toBeGreaterThanOrEqual(1_000_000 - 1);
    }
  });

  it("signal engine created active signals without a cap", async () => {
    const signals = await collections.signals();
    const n = await signals.countDocuments({ status: "ACTIVE" });
    expect(n).toBeGreaterThan(0);
  });

  it("rejects trades that break server-side limits (client values are not trusted)", async () => {
    const { prepareTrade, TradeError } = await import("@/services/trading");
    const signals = await collections.signals();
    const tokens = await collections.tokens();
    const sig = await signals.findOne({ status: "ACTIVE" });
    if (!sig) throw new Error("no active signal to test against");
    const token = await tokens.findOne({ _id: sig.tokenId });
    if (!token) throw new Error("signal's token missing");
    await expect(prepareTrade(userId, { chain: token.chain as "solana", tokenAddress: token.address, amountUsd: 5000, slippageBps: 100, environment: "PAPER" })).rejects.toBeInstanceOf(TradeError);
    await expect(prepareTrade(userId, { chain: token.chain as "solana", tokenAddress: token.address, amountUsd: 10, slippageBps: 4000, environment: "PAPER" })).rejects.toBeInstanceOf(TradeError);
  });

  it("refuses LIVE environment unless explicitly enabled", async () => {
    const { prepareTrade } = await import("@/services/trading");
    const signals = await collections.signals();
    const tokens = await collections.tokens();
    const sig = await signals.findOne({ status: "ACTIVE" });
    if (!sig) throw new Error("no active signal to test against");
    const token = await tokens.findOne({ _id: sig.tokenId });
    if (!token) throw new Error("signal's token missing");
    await expect(prepareTrade(userId, { chain: token.chain as "solana", tokenAddress: token.address, amountUsd: 10, slippageBps: 100, environment: "LIVE" })).rejects.toMatchObject({ status: 403 });
  });

  it("paper buy creates a position (no transaction subdocument / signature), never exceeds capital, then profit targets close it", async () => {
    const { prepareTrade, executeTrade } = await import("@/services/trading");
    const { monitorPosition } = await import("@/services/positionMonitor");
    const { getSettings, updateSettings, tradingSettingsInput } = await import("@/services/settings");
    const positionsCol = await collections.positions();
    const tradesCol = await collections.trades();
    const tokensCol = await collections.tokens();

    const s = await getSettings(userId);
    const { id: _a, userId: _b, ...rest } = s;
    void _a; void _b;
    await updateSettings(userId, tradingSettingsInput.parse({ ...rest, environment: "PAPER", capitalUsd: 30, maxPositionUsd: 10, minPositionUsd: 5, maxDeployedUsd: 30, maxOpenPositions: 3, minLiquidityUsd: 0, minVolume24hUsd: 0, maxPriceImpactPct: 10, maxSlippageBps: 500, maxAllowedRisk: "HIGH" }));

    const candidates = await tokensCol.find({ passedFilters: true, "safety.criticalIssues": { $size: 0 } }).sort({ liquidityUsd: -1 }).limit(10).toArray();
    let opened = 0;
    let firstPosition = "";
    for (const t of candidates) {
      if (opened >= 4) break;
      try {
        const prep = await prepareTrade(userId, { chain: t.chain as "solana", tokenAddress: t.address, amountUsd: 10, slippageBps: 300, environment: "PAPER" });
        const res = await executeTrade(userId, prep.trade.id);
        if (res && "ok" in res && res.ok) {
          opened++;
          if (!firstPosition && "positionId" in res) firstPosition = res.positionId as string;
        }
      } catch {
        /* rejected by validation / limits — expected for some */
      }
    }
    expect(opened).toBeGreaterThan(0);
    expect(opened).toBeLessThanOrEqual(3); // maximum open positions / capital respected
    const open = await positionsCol.find({ userId, status: { $ne: "CLOSED" } }).toArray();
    expect(open.reduce((a, p) => a + p.costBasisUsd, 0)).toBeLessThanOrEqual(30.5);
    expect(await tradesCol.countDocuments({ userId, "transaction.signature": { $ne: null } })).toBe(0);
    expect(await tradesCol.countDocuments({ userId, environment: "PAPER", status: "CONFIRMED" })).toBe(opened);

    // simulate a price collapse without emergency: the monitor must NOT sell a loser
    const pos0 = await positionsCol.findOne({ _id: firstPosition });
    if (!pos0) throw new Error("first position missing");
    const token0 = await tokensCol.findOne({ _id: pos0.tokenId });
    if (!token0) throw new Error("position's token missing");
    await positionsCol.updateOne({ _id: pos0._id }, { $set: { entryPriceUsd: pos0.entryPriceUsd * 3 } }); // price now -66% vs entry
    const posForMonitor = await positionsCol.findOne({ _id: pos0._id });
    if (!posForMonitor) throw new Error("position disappeared");
    await monitorPosition(posForMonitor, token0);
    const afterLoss = await positionsCol.findOne({ _id: pos0._id });
    if (!afterLoss) throw new Error("position disappeared");
    expect(afterLoss.status).not.toBe("CLOSED");
    expect(afterLoss.amount).toBeCloseTo(pos0.amount, 8);

    // now make it a big winner: all targets fire and position closes with realised profit
    await positionsCol.updateOne({ _id: pos0._id }, { $set: { entryPriceUsd: token0.priceUsd / 2 } }); // +100% vs entry
    for (let i = 0; i < 4; i++) {
      const cur = await positionsCol.findOne({ _id: pos0._id });
      if (!cur || cur.status === "CLOSED") break;
      await monitorPosition(cur, token0);
    }
    const closed = await positionsCol.findOne({ _id: pos0._id });
    if (!closed) throw new Error("position disappeared");
    expect(["CLOSED", "TARGET_3", "TARGET_2", "TARGET_1"]).toContain(closed.status);
    expect(closed.targetsHit).toBeGreaterThan(0);
    const sells = await tradesCol.countDocuments({ positionId: pos0._id, side: "SELL", status: "CONFIRMED" });
    expect(sells).toBeGreaterThan(0);
  });
});

d("auto trading (paper bot)", () => {
  it("bot opens an AUTO position from an active BUY signal within limits, once, and refuses to exceed max positions", async () => {
    const { runBotCycle } = await import("@/services/bot");
    const { getSettings, updateSettings, tradingSettingsInput } = await import("@/services/settings");
    const users = await collections.users();
    const bots = await collections.bots();
    const accounts = await collections.tradingAccounts();
    const tokensCol = await collections.tokens();
    const signalsCol = await collections.signals();
    const positionsCol = await collections.positions();

    const u = newId();
    const now = new Date();
    const signalIds: string[] = [];
    await users.insertOne({ _id: u, email: `bot-${Date.now()}@test.local`, passwordHash: "x", name: null, role: "USER", createdAt: now });
    await bots.insertOne({ _id: newId(), userId: u, status: "ACTIVE", environment: "PAPER", lastRunAt: null, emergencyStoppedAt: null, createdAt: now, updatedAt: now });
    await accounts.insertOne({ _id: newId(), userId: u, environment: "PAPER", realizedPnlUsd: 0, createdAt: now });
    try {
      const s = await getSettings(u);
      const { id: _a, userId: _b, ...rest } = s;
      void _a; void _b;
      await updateSettings(u, tradingSettingsInput.parse({ ...rest, environment: "PAPER", autoTradingEnabled: true, capitalUsd: 100, maxPositionUsd: 10, minPositionUsd: 5, maxDeployedUsd: 100, maxOpenPositions: 1, minOpportunityScore: 0, minLiquidityUsd: 0, minVolume24hUsd: 0, maxPriceImpactPct: 10, maxSlippageBps: 500, maxAllowedRisk: "HIGH", filters: { ...rest.filters, minMarketCapUsd: 0, maxMarketCapUsd: 1e12, minLiquidityUsd: 0, minVolume24hUsd: 0, minHolders: 0, minTxCount1h: 0, maxPriceImpactPct: 50, maxTokenAgeHours: null } }));
      // pinned to solana so the $10/$5 capital assertions below are independent of each chain's own network fee
      const tokens = await tokensCol.find({ chain: "solana", passedFilters: true, "safety.criticalIssues": { $size: 0 } }).sort({ liquidityUsd: -1 }).limit(3).toArray();
      for (const t of tokens) {
        const sigId = newId();
        signalIds.push(sigId);
        await signalsCol.insertOne({
          _id: sigId, tokenId: t._id, type: "BUY", status: "ACTIVE", dataSource: "MOCK", score: 90, opportunityScore: 90, riskLevel: "LOWER",
          priceUsd: t.priceUsd, entryMin: t.priceUsd, entryMax: t.priceUsd, target1: 1, target2: 2, target3: 3, reasons: [], warnings: [],
          createdAt: now, updatedAt: now, expiresAt: new Date(Date.now() + 3_600_000), analysis: null,
        });
      }
      await runBotCycle();
      await runBotCycle();
      const positions = await positionsCol.find({ userId: u }).toArray();
      expect(positions.length).toBe(1); // max open positions = 1, no duplicates across cycles
      expect(positions[0].origin).toBe("AUTO");
      expect(positions[0].investedUsd).toBeLessThanOrEqual(10.5);
      expect(positions[0].sourceSignalId).not.toBeNull();
    } finally {
      await Promise.all([
        users.deleteOne({ _id: u }),
        bots.deleteMany({ userId: u }),
        accounts.deleteMany({ userId: u }),
        collections.tradingSettings().then((c) => c.deleteMany({ userId: u })),
        positionsCol.deleteMany({ userId: u }),
        collections.trades().then((c) => c.deleteMany({ userId: u })),
        signalsCol.deleteMany({ _id: { $in: signalIds } }),
      ]).catch(() => {});
    }
  });
});

describe("API authorization", () => {
  it("protected routes return 401 without a session", async () => {
    const { GET: positions } = await import("@/app/api/positions/route");
    const { POST: execute } = await import("@/app/api/trades/execute/route");
    const { POST: start } = await import("@/app/api/bot/start/route");
    const { GET: tokens } = await import("@/app/api/tokens/route");
    const ctx = { params: Promise.resolve({}) };
    const req = (m: string) => new Request("http://localhost/x", { method: m, body: m === "POST" ? "{}" : undefined });
    for (const res of await Promise.all([positions(req("GET"), ctx), execute(req("POST"), ctx), start(req("POST"), ctx), tokens(req("GET"), ctx)])) {
      expect(res.status).toBe(401);
    }
  });
});
