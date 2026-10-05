/**
 * Notifications beyond "a sell was queued": a buy the bot queued, trades expiring unsigned, confirmations and failures,
 * position alerts, a dead scanner — plus the per-category switches.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("next/headers", () => ({ cookies: async () => ({ get: () => undefined, set: () => {}, delete: () => {} }) }));
vi.mock("@/lib/env", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/env")>()), liveTradingAllowed: () => true }));

import { closeDb, collections, newId } from "@/lib/db";
import type { NotificationType, TokenDoc, TradeDoc } from "@/lib/models";
import { buyQueued, CATEGORY_OF, NOTIFICATION_CATEGORIES, positionAlert, scannerOffline, tradeConfirmed, tradeExpired, tradeFailed } from "@/services/notificationMessages";
import { notificationPrefsInput, pushToChannels, saveNotificationPrefs } from "@/services/notifications";

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

const ALL_TYPES: NotificationType[] = ["BUY_QUEUED", "SELL_QUEUED", "AUTOSELL_SUGGESTED", "AUTOSELL_PROBLEM", "PROFIT_TAKEN", "TRADE_EXPIRED", "TRADE_CONFIRMED", "TRADE_FAILED", "POSITION_ALERT", "SYSTEM_ALERT"];

describe("wording", () => {
  it("every type belongs to exactly one switchable category", () => {
    for (const t of ALL_TYPES) expect(NOTIFICATION_CATEGORIES).toContain(CATEGORY_OF[t]);
    expect(Object.keys(CATEGORY_OF).sort()).toEqual([...ALL_TYPES].sort());
  });

  it("a bot buy says what, how much, where and how long you have", () => {
    const m = buyQueued("PEPE", "Base", 10, 0.456, "t1", "tok1");
    expect(m.title).toBe("Buy ready to sign: PEPE");
    expect(m.body).toContain("$10.00 of PEPE on Base");
    expect(m.body).toContain("0.46%");
    expect(m.body).toContain("15 minutes");
    expect(m).toMatchObject({ type: "BUY_QUEUED", url: "/wallet", dedupeKey: "buy:tok1", priority: "high" });
  });

  it("confirmations carry the amounts and, for sells, the realised profit or loss", () => {
    const buy = tradeConfirmed({ side: "BUY", symbol: "PEPE", chainName: "Base", usd: 10.02, tokens: 1234.5678, tradeId: "t" });
    expect(buy.title).toBe("Bought PEPE");
    expect(buy.body).toContain("1,234.57 PEPE for about $10.02");
    const win = tradeConfirmed({ side: "SELL", symbol: "PEPE", chainName: "Base", usd: 12.5, tokens: 300, tradeId: "t", realizedDeltaUsd: 2.5, closed: false });
    // a sell now leads with the profit percentage: $2.50 made on a slice that cost $10 is +25%
    expect(win.type).toBe("PROFIT_TAKEN");
    expect(win.title).toBe("Profit taken: PEPE +25.0%");
    expect(win.body).toContain("profit +$2.50 (+25.0% on that portion)");
    expect(win.body).toContain("rest stays open");
    const loss = tradeConfirmed({ side: "SELL", symbol: "PEPE", chainName: "Base", usd: 7, tokens: 300, tradeId: "t", realizedDeltaUsd: -3, closed: true });
    expect(loss.title).toBe("Sold PEPE at a loss: -30.0%");
    expect(loss.body).toContain("loss -$3.00");
    expect(loss.body).toContain("Position closed");
  });

  it("failures, expiries, position alerts and scanner outages are specific and ASCII-titled", () => {
    expect(tradeFailed("BUY", "PEPE", "slippage exceeded", "t")).toMatchObject({ type: "TRADE_FAILED", title: "Buy failed: PEPE", url: "/trades", dedupeKey: "failed:t" });
    expect(tradeExpired("TARGET_EXIT", "SELL", "PEPE", "t").body).toContain("nothing was sold");
    expect(tradeExpired("AUTO_ENTRY", "BUY", "PEPE", "t").body).toContain("nothing was bought");
    expect(tradeExpired("EMERGENCY_EXIT", "SELL", "PEPE", "t").priority).toBe("urgent");
    const e = positionAlert("EMERGENCY", "PEPE", "Liquidity dropped 80%", "p1");
    expect(e).toMatchObject({ type: "POSITION_ALERT", priority: "urgent", dedupeKey: "health:p1:EMERGENCY" });
    expect(e.body).toContain("Consider selling now");
    expect(positionAlert("WARNING", "PEPE", "x", "p1").priority).toBe("default");
    expect(scannerOffline(42.4).body).toContain("42 minutes");
    for (const m of [buyQueued("Zéro", "B", 1, 1, "t", "k"), tradeFailed("SELL", "X", "r", "t"), positionAlert("WARNING", "X", "w", "p"), scannerOffline(30)]) expect(m.title.trim().length).toBeGreaterThan(0);
  });
});

describe("category switches are validated", () => {
  it("defaults to everything on, accepts known categories, rejects unknown ones", () => {
    expect(notificationPrefsInput.parse({ ntfyTopic: null, discordWebhook: null }).muted).toEqual([]);
    expect(notificationPrefsInput.safeParse({ ntfyTopic: null, discordWebhook: null, muted: ["results", "system"] }).success).toBe(true);
    expect(notificationPrefsInput.safeParse({ ntfyTopic: null, discordWebhook: null, muted: ["everything"] }).success).toBe(false);
  });
});

(dbUp ? describe : describe.skip)("events raise the right notifications", () => {
  const userId = newId();
  const otherUser = newId();
  let token: TokenDoc;
  let accountId = "";
  const tokenIds: string[] = [];
  const SIG = (c: string) => "5" + c.repeat(80);

  const mine = async (type?: NotificationType) => (await (await collections.notifications()).find({ userId, ...(type ? { type } : {}) }).sort({ createdAt: 1 }).toArray());
  const clear = async () => (await collections.notifications()).deleteMany({ userId });

  async function trade(over: Partial<TradeDoc> & { ageMs?: number } = {}): Promise<string> {
    const id = newId();
    const createdAt = new Date(Date.now() - (over.ageMs ?? 0));
    const { ageMs: _a, ...rest } = over;
    void _a;
    await (await collections.trades()).insertOne({
      _id: id, userId, accountId, tokenId: token._id, positionId: null, side: "BUY", kind: "AUTO_ENTRY", environment: "LIVE", dataSource: "MOCK", status: "PREPARED",
      inputUsd: 10, tokenAmount: 100, priceUsd: token.priceUsd, priceImpactPct: 0.5, slippageBps: 300, feesUsd: 0, networkFeeUsd: 0.02, realizedPnlUsd: null,
      quote: { signalId: null }, failureReason: null, expiresAt: new Date(Date.now() + 60_000), createdAt, executedAt: null,
      transaction: { chain: token.chain, signature: null, status: "PENDING", unsignedTx: "tx", error: null, slot: null, submittedAt: null, confirmedAt: null, createdAt },
      ...rest,
    } as TradeDoc);
    return id;
  }

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
    if (!t) throw new Error("no analysed mock token");
    token = t;
    const now = new Date();
    const users = await collections.users();
    await users.insertMany([
      { _id: userId, email: `ev-${Date.now()}@test.local`, passwordHash: "x", name: null, role: "USER", createdAt: now },
      { _id: otherUser, email: `ev2-${Date.now()}@test.local`, passwordHash: "x", name: null, role: "USER", createdAt: now },
    ]);
    accountId = newId();
    await (await collections.tradingAccounts()).insertOne({ _id: accountId, userId, environment: "LIVE", realizedPnlUsd: 0, createdAt: now });
    await (await collections.wallets()).insertMany([
      { _id: newId(), userId, chain: "solana", address: "W".repeat(44), label: null, verifiedAt: now, createdAt: now },
      { _id: newId(), userId: otherUser, chain: "solana", address: "V".repeat(44), label: null, verifiedAt: now, createdAt: now },
    ]);
    await getSettings(userId);
    await (await collections.tradingSettings()).updateOne({ userId }, { $set: { minOpportunityScore: 0, minLiquidityUsd: 0, minVolume24hUsd: 0, maxPriceImpactPct: 50, maxAllowedRisk: "HIGH" } });
  });

  afterEach(() => vi.restoreAllMocks());
  afterAll(async () => {
    const both = { $in: [userId, otherUser] };
    await Promise.all([
      (await collections.users()).deleteMany({ _id: both }), (await collections.tradingAccounts()).deleteMany({ userId }), (await collections.wallets()).deleteMany({ userId: both }),
      (await collections.tradingSettings()).deleteMany({ userId }), (await collections.trades()).deleteMany({ userId }), (await collections.positions()).deleteMany({ userId }),
      (await collections.notifications()).deleteMany({ userId: both }), (await collections.notificationPrefs()).deleteMany({ _id: both }), (await collections.tokens()).deleteMany({ _id: { $in: tokenIds } }),
    ]).catch(() => {});
  });

  async function pinFill() {
    const { providers } = await import("@/core/providers/registry");
    await (await collections.tokens()).updateOne({ _id: token._id }, { $set: { priceUsd: token.priceUsd, lastScannedAt: new Date() } });
    const real = providers().dex.getQuote.bind(providers().dex);
    vi.spyOn(providers().dex, "getQuote").mockImplementation(async (req) => ({ ...(await real(req)), effectivePriceUsd: token.priceUsd, priceImpactPct: 0.3 }));
    vi.spyOn(providers().dex, "buildSwapTransaction").mockResolvedValue({ unsignedTxBase64: "unsigned" });
  }
  const buyInput = () => ({ chain: "solana" as const, tokenAddress: token.address, amountUsd: 5, slippageBps: 100, environment: "LIVE" as const });

  it("a buy the bot queues notifies; a buy you make by hand does not", async () => {
    const { prepareTrade } = await import("@/services/trading");
    await clear();
    await pinFill();
    await prepareTrade(userId, buyInput(), "MANUAL_ENTRY").catch((e) => { throw new Error(`manual: ${e.message} ${JSON.stringify(e.violations)}`); });
    expect(await mine()).toHaveLength(0);
    const auto = await prepareTrade(userId, buyInput(), "AUTO_ENTRY");
    const n = await mine("BUY_QUEUED");
    expect(n).toHaveLength(1);
    expect(n[0]).toMatchObject({ tradeId: auto.trade.id, url: "/wallet" });
    expect(n[0].title).toContain(token.symbol);
    // a second bot buy of the same token inside the reminder window is not announced again
    // (a quote refreshes the stored price, so put the listed price back where the pinned fill expects it)
    await (await collections.tokens()).updateOne({ _id: token._id }, { $set: { priceUsd: token.priceUsd, lastScannedAt: new Date() } });
    await prepareTrade(userId, buyInput(), "AUTO_ENTRY");
    expect(await mine("BUY_QUEUED")).toHaveLength(1);
  });

  it("trades the bot queued that expire unsigned are reported once; hand-made ones are not", async () => {
    const { expirePreparedTrades } = await import("@/services/trading");
    await clear();
    const past = new Date(Date.now() - 60_000);
    const bot = await trade({ kind: "AUTO_ENTRY", expiresAt: past });
    const sell = await trade({ kind: "TARGET_EXIT", side: "SELL", expiresAt: past });
    const hand = await trade({ kind: "MANUAL_ENTRY", expiresAt: past });
    const live = await trade({ kind: "AUTO_ENTRY", expiresAt: new Date(Date.now() + 600_000) });
    expect(await expirePreparedTrades()).toBeGreaterThanOrEqual(3);
    const trades = await collections.trades();
    expect((await trades.findOne({ _id: bot }))?.status).toBe("EXPIRED");
    expect((await trades.findOne({ _id: hand }))?.status).toBe("EXPIRED");
    expect((await trades.findOne({ _id: live }))?.status).toBe("PREPARED");
    const n = await mine("TRADE_EXPIRED");
    expect(n.map((x) => x.tradeId).sort()).toEqual([bot, sell].sort());
    await expirePreparedTrades(); // running again must not repeat them
    expect(await mine("TRADE_EXPIRED")).toHaveLength(2);
  });

  it("a confirmed buy opens the position and says so; a confirmed sell reports the realised P/L", async () => {
    const { reconcileLiveTrade } = await import("@/services/trading");
    const { providers } = await import("@/core/providers/registry");
    await clear();
    vi.spyOn(providers().dex, "getTransactionStatus").mockResolvedValue({ status: "CONFIRMED", slot: 9 });
    const buyId = await trade({ status: "PENDING", expiresAt: null, kind: "MANUAL_ENTRY", transaction: { chain: token.chain, signature: SIG("e"), status: "PENDING", unsignedTx: "x", error: null, slot: null, submittedAt: new Date(), confirmedAt: null, createdAt: new Date() } });
    expect(await reconcileLiveTrade(buyId)).toMatchObject({ ok: true, status: "CONFIRMED" });
    const bought = await mine("TRADE_CONFIRMED");
    expect(bought).toHaveLength(1);
    expect(bought[0].title).toBe(`Bought ${token.symbol}`);
    expect(bought[0].url).toBe("/positions");

    const positionId = (await (await collections.trades()).findOne({ _id: buyId }))!.positionId!;
    const sellId = await trade({ status: "PENDING", expiresAt: null, kind: "TARGET_EXIT", side: "SELL", positionId, inputUsd: 25, transaction: { chain: token.chain, signature: SIG("f"), status: "PENDING", unsignedTx: "x", error: null, slot: null, submittedAt: new Date(), confirmedAt: null, createdAt: new Date() } });
    const pos = (await (await collections.positions()).findOne({ _id: positionId }))!;
    await (await collections.trades()).updateOne({ _id: sellId }, { $set: { tokenAmount: pos.amount / 2 } });
    expect(await reconcileLiveTrade(sellId)).toMatchObject({ ok: true });
    const sold = (await mine("PROFIT_TAKEN")).find((n) => n.tradeId === sellId)!;
    expect(sold.title).toContain(token.symbol);
    expect(sold.title).toMatch(/^(Profit taken|Sold .* at a loss)/);
    expect(sold.body).toMatch(/% on that portion\)/); // the percentage made (or lost) on what was sold
  });

  it("a trade that fails on-chain notifies with the reason, once", async () => {
    const { reconcileLiveTrade } = await import("@/services/trading");
    const { providers } = await import("@/core/providers/registry");
    await clear();
    vi.spyOn(providers().dex, "getTransactionStatus").mockResolvedValue({ status: "FAILED", error: "slippage tolerance exceeded" });
    const id = await trade({ status: "PENDING", expiresAt: null, transaction: { chain: token.chain, signature: SIG("g"), status: "PENDING", unsignedTx: "x", error: null, slot: null, submittedAt: new Date(), confirmedAt: null, createdAt: new Date() } });
    await reconcileLiveTrade(id);
    await reconcileLiveTrade(id); // already FAILED: nothing more to say
    const n = await mine("TRADE_FAILED");
    expect(n).toHaveLength(1);
    expect(n[0].body).toContain("slippage tolerance exceeded");
    expect(n[0].url).toBe("/trades");
  });

  it("a position whose health turns to emergency raises an alert, and not again straight after", async () => {
    const { monitorPosition } = await import("@/services/positionMonitor");
    const { providers } = await import("@/core/providers/registry");
    await clear();
    const posId = newId();
    const now = new Date();
    await (await collections.positions()).insertOne({
      _id: posId, userId, accountId, tokenId: token._id, environment: "LIVE", status: "OPEN", health: "HOLD", healthNotes: { entryLiquidityUsd: 1e12 }, origin: "MANUAL", sourceSignalId: null,
      entryPriceUsd: token.priceUsd, currentPriceUsd: token.priceUsd, initialAmount: 10, amount: 10, investedUsd: 1, costBasisUsd: 1, realizedPnlUsd: 0, targetsHit: 0, targetsSnapshot: [],
      emergencyEnabled: true, emergencyAutoExit: false, openedAt: now, updatedAt: now, closedAt: null, lastAnalysisAt: null,
    } as never);
    // the pool now holds a tiny fraction of the liquidity it had when the position opened
    vi.spyOn(providers().data, "getSnapshot").mockImplementation(async () => ({
      chain: token.chain, address: token.address, name: token.name, symbol: token.symbol, decimals: token.decimals, dex: token.dex, poolAddress: token.poolAddress, poolCreatedAt: token.poolCreatedAt,
      pairCount: 1, priceUsd: token.priceUsd, marketCapUsd: token.marketCapUsd, fdvUsd: token.fdvUsd, liquidityUsd: 50_000, liquidity1hAgoUsd: 5_000_000, volume5m: 1, volume15m: 1, volume30m: 1, volume1h: 1, volume24h: 1,
      buys5m: 1, sells5m: 1, buys15m: 1, sells15m: 1, buys1h: 1, sells1h: 1, change5m: 0, change1h: 0, change24h: 0, holders: 100, holders1hAgo: 100, observedAt: new Date(), dataSource: "MOCK",
    }) as never);
    const run = async () => monitorPosition((await (await collections.positions()).findOne({ _id: posId }))!, token);
    await run();
    const alerts = await mine("POSITION_ALERT");
    expect(alerts.length).toBeGreaterThanOrEqual(1);
    expect(alerts[0].title).toContain(token.symbol);
    expect(alerts[0].url).toBe("/positions");
    const count = alerts.length;
    await (await collections.positions()).updateOne({ _id: posId }, { $set: { health: "HOLD" } }); // flapping back and forth must not re-alert within the window
    await run();
    expect((await mine("POSITION_ALERT")).length).toBe(count);
  });

  it("a stopped scanner is reported to wallet users once per reminder window, but not when fresh or never run", async () => {
    const { checkScannerHealth } = await import("@/services/notifications");
    const states = await collections.workerStates();
    const saved = await states.findOne({ _id: "scanner-worker" });
    await clear();
    await (await collections.notifications()).deleteMany({ userId: otherUser });
    try {
      const T = Date.now();
      await states.deleteOne({ _id: "scanner-worker" });
      expect(await checkScannerHealth(T)).toEqual({ stale: false, notified: 0 }); // never ran: a fresh install, not an outage
      await states.insertOne({ _id: "scanner-worker", lastRunAt: new Date(T - 5 * 60_000), lastError: null, leaseUntil: null, runs: 1, stats: null, updatedAt: new Date() });
      expect((await checkScannerHealth(T)).stale).toBe(false);
      await states.updateOne({ _id: "scanner-worker" }, { $set: { lastRunAt: new Date(T - 45 * 60_000) } });
      const r = await checkScannerHealth(T);
      expect(r.stale).toBe(true);
      expect(r.notified).toBeGreaterThanOrEqual(2);
      await checkScannerHealth(T); // reminder window not over
      expect(await mine("SYSTEM_ALERT")).toHaveLength(1);
      expect((await (await collections.notifications()).find({ userId: otherUser, type: "SYSTEM_ALERT" }).toArray())).toHaveLength(1);
    } finally {
      await states.deleteOne({ _id: "scanner-worker" });
      if (saved) await states.insertOne(saved);
    }
  });

  it("a switched-off category is neither recorded nor pushed; the others still are", async () => {
    const { notifyUser } = await import("@/services/notifications");
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("ok", { status: 200 }));
    await clear();
    await saveNotificationPrefs(userId, { ntfyTopic: "dexscout-k3j9x2m7q", discordWebhook: null, muted: ["results", "system"] });
    await notifyUser(userId, tradeFailed("BUY", "X", "boom", "m1")); // results: muted
    await notifyUser(userId, scannerOffline(30)); // system: muted
    expect(await mine()).toHaveLength(0);
    expect(fetchSpy).not.toHaveBeenCalled();
    await notifyUser(userId, buyQueued("X", "Base", 5, 0.1, "m2", "tk")); // approvals: on
    expect(await mine("BUY_QUEUED")).toHaveLength(1);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    await saveNotificationPrefs(userId, { ntfyTopic: null, discordWebhook: null, muted: [] });
  });

  it("emergencies go out to ntfy at urgent priority, ordinary results at the default", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("ok", { status: 200 }));
    await saveNotificationPrefs(userId, { ntfyTopic: "dexscout-k3j9x2m7q", discordWebhook: null, muted: [] });
    await pushToChannels(userId, positionAlert("EMERGENCY", "X", "liquidity gone", "p"));
    await pushToChannels(userId, tradeConfirmed({ side: "BUY", symbol: "X", chainName: "Base", usd: 5, tokens: 5, tradeId: "t" }));
    const headers = fetchSpy.mock.calls.map((c) => (c[1] as RequestInit).headers as Record<string, string>);
    expect(headers[0].Priority).toBe("urgent");
    expect(headers[0].Tags).toBe("rotating_light");
    expect(headers[1].Priority).toBe("default");
    await saveNotificationPrefs(userId, { ntfyTopic: null, discordWebhook: null, muted: [] });
  });
});
