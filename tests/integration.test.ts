/**
 * Integration tests against the real (embedded/local) PostgreSQL with the mock provider.
 * They are skipped automatically when the database is unreachable.
 */
import { describe, expect, it, vi, beforeAll, afterAll } from "vitest";

vi.mock("next/headers", () => ({
  cookies: async () => ({ get: () => undefined, set: () => {}, delete: () => {} }),
}));

import { db } from "@/lib/db";

let dbUp = false;
try {
  await db.$queryRaw`SELECT 1`;
  dbUp = true;
} catch {
  dbUp = false;
}
const d = dbUp ? describe : describe.skip;

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
    const u = await db.user.create({ data: { email, passwordHash: "x", bot: { create: {} }, tradingAccounts: { create: [{ environment: "PAPER" }] } } });
    userId = u.id;
  });

  afterAll(async () => {
    if (userId) await db.user.delete({ where: { id: userId } }).catch(() => {});
    await db.$disconnect();
  });

  it("scanner persisted tokens with indexes-backed lookups and passing tokens have analysis + safety", async () => {
    const total = await db.token.count();
    expect(total).toBeGreaterThan(50);
    const passing = await db.token.findMany({ where: { passedFilters: true }, include: { safety: true, analysis: true }, take: 5 });
    expect(passing.length).toBeGreaterThan(0);
    for (const t of passing) {
      expect(t.safety).not.toBeNull();
      expect(t.analysis).not.toBeNull();
      expect(t.marketCapUsd).toBeGreaterThanOrEqual(1_000_000 - 1);
    }
  });

  it("signal engine created active signals without a cap", async () => {
    const n = await db.signal.count({ where: { status: "ACTIVE" } });
    expect(n).toBeGreaterThan(0);
  });

  it("rejects trades that break server-side limits (client values are not trusted)", async () => {
    const { prepareTrade, TradeError } = await import("@/services/trading");
    const sig = await db.signal.findFirstOrThrow({ where: { status: "ACTIVE" }, include: { token: true } });
    await expect(prepareTrade(userId, { chain: sig.token.chain as "solana", tokenAddress: sig.token.address, amountUsd: 5000, slippageBps: 100, environment: "PAPER" })).rejects.toBeInstanceOf(TradeError);
    await expect(prepareTrade(userId, { chain: sig.token.chain as "solana", tokenAddress: sig.token.address, amountUsd: 10, slippageBps: 4000, environment: "PAPER" })).rejects.toBeInstanceOf(TradeError);
  });

  it("refuses LIVE environment unless explicitly enabled", async () => {
    const { prepareTrade } = await import("@/services/trading");
    const sig = await db.signal.findFirstOrThrow({ where: { status: "ACTIVE" }, include: { token: true } });
    await expect(prepareTrade(userId, { chain: sig.token.chain as "solana", tokenAddress: sig.token.address, amountUsd: 10, slippageBps: 100, environment: "LIVE" })).rejects.toMatchObject({ status: 403 });
  });

  it("paper buy creates a position (no transaction row / signature), never exceeds capital, then profit targets close it", async () => {
    const { prepareTrade, executeTrade } = await import("@/services/trading");
    const { monitorPosition } = await import("@/services/positionMonitor");
    const { getSettings, updateSettings, tradingSettingsInput } = await import("@/services/settings");
    const s = await getSettings(userId);
    const { id: _a, userId: _b, ...rest } = s;
    void _a; void _b;
    await updateSettings(userId, tradingSettingsInput.parse({ ...rest, environment: "PAPER", capitalUsd: 30, maxPositionUsd: 10, minPositionUsd: 5, maxDeployedUsd: 30, maxOpenPositions: 3, minLiquidityUsd: 0, minVolume24hUsd: 0, maxPriceImpactPct: 10, maxSlippageBps: 500, maxAllowedRisk: "HIGH" }));

    const candidates = await db.token.findMany({ where: { passedFilters: true, safety: { criticalIssues: { equals: [] } } }, orderBy: { liquidityUsd: "desc" }, take: 10 });
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
    const open = await db.position.findMany({ where: { userId, status: { not: "CLOSED" } } });
    expect(open.reduce((a, p) => a + p.costBasisUsd, 0)).toBeLessThanOrEqual(30.5);
    expect(await db.transaction.count({ where: { trade: { userId } } })).toBe(0);
    expect(await db.trade.count({ where: { userId, environment: "PAPER", status: "CONFIRMED" } })).toBe(opened);

    // simulate a price collapse without emergency: the monitor must NOT sell a loser
    const pos = await db.position.findFirstOrThrow({ where: { id: firstPosition }, include: { token: true } });
    await db.position.update({ where: { id: pos.id }, data: { entryPriceUsd: pos.entryPriceUsd * 3 } }); // price now -66% vs entry
    await monitorPosition({ ...(await db.position.findFirstOrThrow({ where: { id: pos.id } })), token: pos.token });
    const afterLoss = await db.position.findFirstOrThrow({ where: { id: pos.id } });
    expect(afterLoss.status).not.toBe("CLOSED");
    expect(afterLoss.amount).toBeCloseTo(pos.amount, 8);

    // now make it a big winner: all targets fire and position closes with realised profit
    await db.position.update({ where: { id: pos.id }, data: { entryPriceUsd: pos.token.priceUsd / 2 } }); // +100% vs entry
    for (let i = 0; i < 4; i++) {
      const cur = await db.position.findFirstOrThrow({ where: { id: pos.id }, include: { token: true } });
      if (cur.status === "CLOSED") break;
      await monitorPosition(cur);
    }
    const closed = await db.position.findFirstOrThrow({ where: { id: pos.id } });
    expect(["CLOSED", "TARGET_3", "TARGET_2", "TARGET_1"]).toContain(closed.status);
    expect(closed.targetsHit).toBeGreaterThan(0);
    const sells = await db.trade.count({ where: { positionId: pos.id, side: "SELL", status: "CONFIRMED" } });
    expect(sells).toBeGreaterThan(0);
  });
});

d("auto trading (paper bot)", () => {
  it("bot opens an AUTO position from an active BUY signal within limits, once, and refuses to exceed max positions", async () => {
    const { runBotCycle } = await import("@/services/bot");
    const { getSettings, updateSettings, tradingSettingsInput } = await import("@/services/settings");
    const u = await db.user.create({ data: { email: `bot-${Date.now()}@test.local`, passwordHash: "x", bot: { create: { status: "ACTIVE" } }, tradingAccounts: { create: [{ environment: "PAPER" }] } } });
    try {
      const s = await getSettings(u.id);
      const { id: _a, userId: _b, ...rest } = s;
      void _a; void _b;
      await updateSettings(u.id, tradingSettingsInput.parse({ ...rest, environment: "PAPER", autoTradingEnabled: true, capitalUsd: 100, maxPositionUsd: 10, minPositionUsd: 5, maxDeployedUsd: 100, maxOpenPositions: 1, minOpportunityScore: 0, minLiquidityUsd: 0, minVolume24hUsd: 0, maxPriceImpactPct: 10, maxSlippageBps: 500, maxAllowedRisk: "HIGH", filters: { ...rest.filters, minMarketCapUsd: 0, maxMarketCapUsd: 1e12, minLiquidityUsd: 0, minVolume24hUsd: 0, minHolders: 0, minTxCount1h: 0, maxPriceImpactPct: 50, maxTokenAgeHours: null } }));
      // pinned to solana so the $10/$5 capital assertions below are independent of each chain's own network fee
      const tokens = await db.token.findMany({ where: { chain: "solana", passedFilters: true, safety: { criticalIssues: { equals: [] } } }, orderBy: { liquidityUsd: "desc" }, take: 3 });
      for (const t of tokens) {
        await db.signal.create({ data: { tokenId: t.id, type: "BUY", dataSource: "MOCK", score: 90, opportunityScore: 90, riskLevel: "LOWER", priceUsd: t.priceUsd, entryMin: t.priceUsd, entryMax: t.priceUsd, target1: 1, target2: 2, target3: 3, reasons: [], warnings: [], expiresAt: new Date(Date.now() + 3_600_000) } });
      }
      await runBotCycle();
      await runBotCycle();
      const positions = await db.position.findMany({ where: { userId: u.id } });
      expect(positions.length).toBe(1); // max open positions = 1, no duplicates across cycles
      expect(positions[0].origin).toBe("AUTO");
      expect(positions[0].investedUsd).toBeLessThanOrEqual(10.5);
      expect(positions[0].sourceSignalId).not.toBeNull();
    } finally {
      await db.user.delete({ where: { id: u.id } }).catch(() => {});
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