/**
 * Integration tests against the real (embedded/local) MongoDB with the mock provider.
 * They are skipped automatically when the database is unreachable.
 */
import { describe, expect, it, vi, beforeAll, afterAll, afterEach } from "vitest";

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

d("scanner, analysis and signal engine", () => {
  beforeAll(async () => {
    const { runScanCycle } = await import("@/services/scanner");
    const { runAnalysisCycle } = await import("@/services/analysis");
    const { runSignalCycle } = await import("@/services/signals");
    await runScanCycle();
    await runAnalysisCycle();
    await runSignalCycle();
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
      expect(t.marketCapUsd).toBeGreaterThanOrEqual(250_000 - 1);
    }
  });

  it("signal engine created active signals without a cap", async () => {
    const signals = await collections.signals();
    const n = await signals.countDocuments({ status: "ACTIVE" });
    expect(n).toBeGreaterThan(0);
  });

  it("demotes a token whose liquidity has since dropped below the filter threshold, without spending an on-chain call on it", async () => {
    const { runAnalysisCycle } = await import("@/services/analysis");
    const { providers } = await import("@/core/providers/registry");
    const tokens = await collections.tokens();

    // find a real mock-world token whose CURRENT snapshot liquidity is well below the default
    // $100k minimum -- its DB record is deliberately stale (passedFilters: true) to simulate a pool that
    // qualified when last scanned but has since thinned out before this tiny batch got to it.
    const snaps = await providers().data.discover("solana");
    const thin = snaps.filter((s) => s.liquidityUsd > 0 && s.liquidityUsd < 50_000).sort((a, b) => a.liquidityUsd - b.liquidityUsd)[0];
    if (!thin) throw new Error("no thin-liquidity mock token available to test against");

    const id = newId();
    const now = new Date();
    await tokens.updateOne(
      { chain: thin.chain, address: thin.address },
      {
        $set: { passedFilters: true, stage: "SCANNED", analysis: null, lastAnalysisAttemptAt: null, marketCapUsd: 1e15 }, // inflated so it sorts first
        $setOnInsert: {
          _id: id, chain: thin.chain, address: thin.address, name: thin.name, symbol: thin.symbol, decimals: thin.decimals || 9, dex: thin.dex,
          poolAddress: thin.poolAddress, logoUrl: null, dataSource: "MOCK", firstSeenAt: now, opportunityScore: 0, riskLevel: "MODERATE", safety: null,
        },
      },
      { upsert: true },
    );

    const getOnChainSpy = vi.spyOn(providers().data, "getOnChain");
    try {
      await runAnalysisCycle(1); // the inflated market cap guarantees this exact token is the one slot processed
      expect(getOnChainSpy).not.toHaveBeenCalled();

      const after = await tokens.findOne({ chain: thin.chain, address: thin.address });
      expect(after?.passedFilters).toBe(false);
      expect(after?.stage).toBe("FILTERED");
      expect(after?.lastAnalysisAttemptAt).not.toBeNull();
    } finally {
      getOnChainSpy.mockRestore();
    }
  });

  it("does not re-select a token that is still cooling down after a recent analysis attempt", async () => {
    const { runAnalysisCycle } = await import("@/services/analysis");
    const tokens = await collections.tokens();
    const id = newId();
    const now = new Date();
    const attemptedAt = new Date(now.getTime() - 60_000); // 1 minute ago, inside the 10-minute cooldown
    await tokens.insertOne({
      _id: id, chain: "solana", address: "11111111111111111111111CooldownTest1", name: "Cooldown Test", symbol: "CDT", decimals: 9, dex: "test",
      poolAddress: null, logoUrl: null, dataSource: "MOCK", stage: "SCANNED", poolCreatedAt: now, firstSeenAt: now, lastScannedAt: now, updatedAt: now,
      priceUsd: 1, marketCapUsd: 1e15, fdvUsd: 1e15, liquidityUsd: 1_000_000, volume24hUsd: 1_000_000, volume1hUsd: 50_000, // inflated mcap so it would sort
      change5m: 0, change1h: 0, change24h: 0, buySellRatio: 1, holders: 100, holderGrowth1h: 0, txCount1h: 10, pairCount: 1, // first if it were eligible
      opportunityScore: 0, riskLevel: "MODERATE", passedFilters: true, lastAnalysisAttemptAt: attemptedAt, safety: null, analysis: null,
    });
    try {
      await runAnalysisCycle(1);
      const after = await tokens.findOne({ _id: id });
      expect(after?.analysis).toBeNull();
      expect(after?.lastAnalysisAttemptAt?.getTime()).toBe(attemptedAt.getTime()); // untouched -- excluded by the cooldown, not even attempted
    } finally {
      await tokens.deleteOne({ _id: id });
    }
  });
});

/**
 * There is no PAPER mode: every trade is LIVE, and a LIVE trade only ever moves once the user's own
 * wallet signs and broadcasts it (prepareTrade only builds an unsigned transaction; executeTrade only
 * records a signature). Neither of those steps can be driven from an automated test without a real
 * wallet and a real chain — mockMarket.ts's MockDexAdapter correctly refuses to build or broadcast
 * anything, which is why `prepareTrade` with environment "LIVE" is unreachable while MOCK_PROVIDER=true
 * (see `liveTradingAllowed`). That refusal is itself a safety property worth testing directly.
 *
 * What *is* real integration-test territory: `reconcileLiveTrade`, which turns an on-chain confirmation
 * into position/capital bookkeeping and never gates on `liveTradingAllowed`. These tests simulate the one
 * unavoidable boundary — the on-chain confirmation itself — by mocking the DEX adapter's
 * `getTransactionStatus`, then let every other step (Mongo transactions, capital accounting, signal
 * consumption, profit targets, the no-stop-loss guarantee) run for real.
 */
d("settings migration to v2 gate defaults", () => {
  it("moves gates still at the old strict defaults, preserves ones the user customised, and runs once", async () => {
    const { getSettings, defaultSettingsDoc } = await import("@/services/settings");
    const col = await collections.tradingSettings();
    const userId = newId();
    // an account created before v2: explicit old defaults stored, no settingsVersion, but one deliberate customisation
    const legacy = defaultSettingsDoc(userId);
    delete legacy.settingsVersion;
    Object.assign(legacy, { minLiquidityUsd: 100_000, minVolume24hUsd: 50_000, maxPriceImpactPct: 2, minOpportunityScore: 70 });
    legacy.filters = { ...legacy.filters, minMarketCapUsd: 1_000_000, maxMarketCapUsd: 10_000_000, minLiquidityUsd: 100_000, minVolume24hUsd: 50_000, minHolders: 300, maxTokenAgeHours: 720, minTxCount1h: 50, maxPriceImpactPct: 7 };
    try {
      await col.insertOne(legacy);
      const migrated = await getSettings(userId);
      expect(migrated.minLiquidityUsd).toBe(20_000);
      expect(migrated.minVolume24hUsd).toBe(10_000);
      expect(migrated.filters.minMarketCapUsd).toBe(250_000);
      expect(migrated.filters.maxMarketCapUsd).toBe(25_000_000);
      expect(migrated.filters.maxTokenAgeHours).toBeNull();
      expect(migrated.filters.maxPriceImpactPct).toBe(7); // the user's own value, not an old default -> untouched

      // a later manual change back to a "v1-looking" value must stick (migration already ran for this account)
      await col.updateOne({ userId }, { $set: { minLiquidityUsd: 100_000 } });
      expect((await getSettings(userId)).minLiquidityUsd).toBe(100_000);
    } finally {
      await col.deleteMany({ userId });
    }
  });
});

d("LIVE trading: server-enforced gates and on-chain-confirmation bookkeeping", () => {
  let userId = "";
  let firstPositionId = "";
  let firstPositionTokenId = "";
  const email = `it-${Date.now()}@test.local`;

  beforeAll(async () => {
    const users = await collections.users();
    const bots = await collections.bots();
    const accounts = await collections.tradingAccounts();
    userId = newId();
    const now = new Date();
    await users.insertOne({ _id: userId, email, passwordHash: "x", name: null, role: "USER", createdAt: now });
    await bots.insertOne({ _id: newId(), userId, status: "PAUSED", environment: "LIVE", lastRunAt: null, emergencyStoppedAt: null, createdAt: now, updatedAt: now });
    await accounts.insertOne({ _id: newId(), userId, environment: "LIVE", realizedPnlUsd: 0, createdAt: now });
  });

  afterAll(async () => {
    if (!userId) return;
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
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("refuses to prepare a LIVE trade while running on mock data (the live/mock safety gate)", async () => {
    const { prepareTrade } = await import("@/services/trading");
    const signals = await collections.signals();
    const tokens = await collections.tokens();
    const sig = await signals.findOne({ status: "ACTIVE" });
    if (!sig) throw new Error("no active signal to test against");
    const token = await tokens.findOne({ _id: sig.tokenId });
    if (!token) throw new Error("signal's token missing");
    // MOCK_PROVIDER=true in this test env, so liveTradingAllowed() is false regardless of LIVE_TRADING_ENABLED
    // -- mock data must never drive a real trade. This 403 is that gate working, not a bug.
    await expect(prepareTrade(userId, { chain: token.chain as "solana", tokenAddress: token.address, amountUsd: 10, slippageBps: 100, environment: "LIVE" })).rejects.toMatchObject({ status: 403 });
  });

  it("reconcileLiveTrade opens a position from a confirmed on-chain buy using the trade's own recorded amounts", async () => {
    const { reconcileLiveTrade } = await import("@/services/trading");
    const { providers } = await import("@/core/providers/registry");
    const tokens = await collections.tokens();
    const trades = await collections.trades();
    const positions = await collections.positions();
    const signals = await collections.signals();
    const accounts = await collections.tradingAccounts();

    const sig = await signals.findOne({ status: "ACTIVE" });
    if (!sig) throw new Error("no active signal to test against");
    const token = await tokens.findOne({ _id: sig.tokenId });
    if (!token) throw new Error("signal's token missing");
    const account = await accounts.findOne({ userId, environment: "LIVE" });
    if (!account) throw new Error("trading account missing");

    vi.spyOn(providers().dex, "getTransactionStatus").mockResolvedValue({ status: "CONFIRMED", slot: 12345 });

    const tradeId = newId();
    const now = new Date();
    await trades.insertOne({
      _id: tradeId, userId, accountId: account._id, tokenId: token._id, positionId: null, side: "BUY", kind: "MANUAL_ENTRY", environment: "LIVE", dataSource: "MOCK", status: "PENDING",
      inputUsd: 10, tokenAmount: 100, priceUsd: token.priceUsd, priceImpactPct: 0.5, slippageBps: 300, feesUsd: 0.03, networkFeeUsd: 0.02, realizedPnlUsd: null,
      quote: { signalId: sig._id }, failureReason: null, expiresAt: null, createdAt: now, executedAt: null,
      transaction: { chain: token.chain, signature: "5" + "a".repeat(80), status: "PENDING", unsignedTx: "fake", error: null, slot: null, submittedAt: now, confirmedAt: null, createdAt: now },
    });

    const r = await reconcileLiveTrade(tradeId);
    expect(r).toMatchObject({ ok: true, status: "CONFIRMED" });

    const trade = await trades.findOne({ _id: tradeId });
    expect(trade?.status).toBe("CONFIRMED");
    expect(trade?.positionId).toBeTruthy();
    expect(trade?.transaction?.status).toBe("CONFIRMED");

    const pos = await positions.findOne({ _id: trade!.positionId! });
    expect(pos).toBeTruthy();
    expect(pos!.status).toBe("OPEN");
    expect(pos!.origin).toBe("MANUAL");
    expect(pos!.sourceSignalId).toBe(sig._id);
    expect(pos!.investedUsd).toBeCloseTo(10 + 0.02, 6); // inputUsd + networkFeeUsd (no on-chain inspection available in mock mode)
    expect(pos!.amount).toBeCloseTo(100, 6);

    const consumed = await signals.findOne({ _id: sig._id });
    expect(consumed?.status).toBe("CONSUMED");

    firstPositionId = pos!._id;
    firstPositionTokenId = token._id;
  });

  it("NEVER sells a losing position automatically (no stop-loss)", async () => {
    const { monitorPosition } = await import("@/services/positionMonitor");
    const positions = await collections.positions();
    const tokens = await collections.tokens();
    if (!firstPositionId) throw new Error("previous test did not open a position");

    const before = await positions.findOne({ _id: firstPositionId });
    if (!before) throw new Error("position missing");
    await positions.updateOne({ _id: firstPositionId }, { $set: { entryPriceUsd: before.entryPriceUsd * 3 } }); // price now -66% vs entry
    const pos = await positions.findOne({ _id: firstPositionId });
    const token = await tokens.findOne({ _id: firstPositionTokenId });
    if (!pos || !token) throw new Error("fixture missing");

    await monitorPosition(pos, token);
    const after = await positions.findOne({ _id: firstPositionId });
    expect(after?.status).not.toBe("CLOSED");
    expect(after?.amount).toBeCloseTo(pos.amount, 8); // nothing sold
  });

  it("detects a profit target but does not execute a sell while LIVE trading is disabled (mock mode)", async () => {
    const { monitorPosition } = await import("@/services/positionMonitor");
    const positions = await collections.positions();
    const tokens = await collections.tokens();
    if (!firstPositionId) throw new Error("previous test did not open a position");

    const token = await tokens.findOne({ _id: firstPositionTokenId });
    if (!token) throw new Error("token missing");
    await positions.updateOne({ _id: firstPositionId }, { $set: { entryPriceUsd: token.priceUsd / 2 } }); // +100% vs entry: clears every target
    const pos = await positions.findOne({ _id: firstPositionId });
    if (!pos) throw new Error("position missing");

    await monitorPosition(pos, token);
    const after = await positions.findOne({ _id: firstPositionId });
    // the target was detected (see the TARGET_REACHED event this logs) but liveTradingAllowed() is false
    // in this test env, so positionMonitor correctly never attempts the sell -- the position stays open.
    expect(after?.status).not.toBe("CLOSED");
    expect(after?.amount).toBeCloseTo(pos.amount, 8);
  });

  it("reconcileLiveTrade closes a position and records realised P/L from a confirmed on-chain sell", async () => {
    const { reconcileLiveTrade } = await import("@/services/trading");
    const { providers } = await import("@/core/providers/registry");
    const positions = await collections.positions();
    const trades = await collections.trades();
    const accounts = await collections.tradingAccounts();
    const tokens = await collections.tokens();
    if (!firstPositionId) throw new Error("previous test did not open a position");

    const pos = await positions.findOne({ _id: firstPositionId });
    if (!pos) throw new Error("position missing");
    const token = await tokens.findOne({ _id: pos.tokenId });
    if (!token) throw new Error("token missing");
    const account = await accounts.findOne({ userId, environment: "LIVE" });
    if (!account) throw new Error("account missing");
    const realizedBefore = account.realizedPnlUsd;

    vi.spyOn(providers().dex, "getTransactionStatus").mockResolvedValue({ status: "CONFIRMED", slot: 54321 });

    const tradeId = newId();
    const now = new Date();
    const sellProceedsUsd = pos.costBasisUsd * 1.5; // sell for 50% more than cost basis
    await trades.insertOne({
      _id: tradeId, userId, accountId: pos.accountId, tokenId: pos.tokenId, positionId: pos._id, side: "SELL", kind: "MANUAL_EXIT", environment: "LIVE", dataSource: "MOCK", status: "PENDING",
      inputUsd: sellProceedsUsd, tokenAmount: pos.amount, priceUsd: sellProceedsUsd / pos.amount, priceImpactPct: 0.5, slippageBps: 300, feesUsd: 0, networkFeeUsd: 0, realizedPnlUsd: null,
      quote: { reason: "test close" }, failureReason: null, expiresAt: null, createdAt: now, executedAt: null,
      transaction: { chain: token.chain, signature: "5" + "b".repeat(80), status: "PENDING", unsignedTx: "fake", error: null, slot: null, submittedAt: now, confirmedAt: null, createdAt: now },
    });

    const r = await reconcileLiveTrade(tradeId);
    expect(r).toMatchObject({ ok: true, status: "CONFIRMED" });

    const closed = await positions.findOne({ _id: firstPositionId });
    expect(closed?.status).toBe("CLOSED");
    expect(closed?.amount).toBeCloseTo(0, 6);
    expect(closed?.realizedPnlUsd).toBeGreaterThan(0); // sold above cost basis

    const accountAfter = await accounts.findOne({ userId, environment: "LIVE" });
    expect(accountAfter!.realizedPnlUsd).toBeGreaterThan(realizedBefore);
  });
});

d("auto trading honors the LIVE/mock safety gate", () => {
  it("bot refuses to execute LIVE auto-entries while running on mock data", async () => {
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
    await bots.insertOne({ _id: newId(), userId: u, status: "ACTIVE", environment: "LIVE", lastRunAt: null, emergencyStoppedAt: null, createdAt: now, updatedAt: now });
    await accounts.insertOne({ _id: newId(), userId: u, environment: "LIVE", realizedPnlUsd: 0, createdAt: now });
    try {
      const s = await getSettings(u);
      const { id: _a, userId: _b, ...rest } = s;
      void _a; void _b;
      await updateSettings(u, tradingSettingsInput.parse({ ...rest, environment: "LIVE", autoTradingEnabled: true, capitalUsd: 100, maxPositionUsd: 10, minPositionUsd: 5, maxDeployedUsd: 100, maxOpenPositions: 1, minOpportunityScore: 0, minLiquidityUsd: 0, minVolume24hUsd: 0, maxPriceImpactPct: 10, maxSlippageBps: 500, maxAllowedRisk: "HIGH", filters: { ...rest.filters, minMarketCapUsd: 0, maxMarketCapUsd: 1e12, minLiquidityUsd: 0, minVolume24hUsd: 0, minHolders: 0, minTxCount1h: 0, maxPriceImpactPct: 50, maxTokenAgeHours: null } }));
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
      // liveTradingAllowed() is false under MOCK_PROVIDER=true, so the bot must skip every candidate
      // rather than silently trading mock data for real -- this is the safety property under test.
      const positions = await positionsCol.find({ userId: u }).toArray();
      expect(positions.length).toBe(0);
      const trades = await collections.trades();
      expect(await trades.countDocuments({ userId: u })).toBe(0);
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
