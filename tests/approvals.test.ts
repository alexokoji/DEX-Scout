/**
 * The wallet-approval queue: "Review & sign" must rebuild a fresh transaction first, and a transaction the wallet
 * already broadcast must always be recorded even if the quote's TTL lapsed while the wallet prompt was open.
 * Runs against the embedded MongoDB with mock data; LIVE is force-enabled (liveTradingAllowed) and the one boundary
 * that needs a real chain — building the swap transaction and confirming it on-chain — is mocked.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("next/headers", () => ({ cookies: async () => ({ get: () => undefined, set: () => {}, delete: () => {} }) }));
vi.mock("@/lib/env", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/env")>()), liveTradingAllowed: () => true }));

import { closeDb, collections, newId } from "@/lib/db";
import type { TokenDoc, TradeDoc } from "@/lib/models";

let dbUp = false;
try {
  await (await collections.users()).findOne({});
  dbUp = true;
} catch {
  dbUp = false;
}
const d = dbUp ? describe : describe.skip;

afterAll(async () => {
  if (dbUp) await closeDb();
});

const SIG = "5" + "a".repeat(80);
const MIN = 60_000;

d("wallet approval queue", () => {
  const userId = newId();
  let token: TokenDoc;
  let accountId = "";
  const created: string[] = [];

  async function makeTrade(over: Partial<TradeDoc> & { ageMs?: number; unsigned?: string }): Promise<string> {
    const trades = await collections.trades();
    const id = newId();
    const createdAt = new Date(Date.now() - (over.ageMs ?? 0));
    const { ageMs: _a, unsigned, ...rest } = over;
    void _a;
    await trades.insertOne({
      _id: id, userId, accountId, tokenId: token._id, positionId: null, side: "BUY", kind: "AUTO_ENTRY", environment: "LIVE", dataSource: "MOCK", status: "PREPARED",
      inputUsd: 5, tokenAmount: 100, priceUsd: token.priceUsd, priceImpactPct: 0.5, slippageBps: 300, feesUsd: 0, networkFeeUsd: 0.02, realizedPnlUsd: null,
      quote: { signalId: null, reason: "bot entry" }, failureReason: null, expiresAt: new Date(Date.now() + MIN), createdAt, executedAt: null,
      transaction: { chain: token.chain, signature: null, status: "PENDING", unsignedTx: unsigned ?? "stale-tx", error: null, slot: null, submittedAt: null, confirmedAt: null, createdAt },
      ...rest,
    } as TradeDoc);
    created.push(id);
    return id;
  }

  beforeAll(async () => {
    const { runScanCycle } = await import("@/services/scanner");
    const { runAnalysisCycle } = await import("@/services/analysis");
    const { getSettings } = await import("@/services/settings");
    const tokens = await collections.tokens();
    let t = await tokens.findOne({ passedFilters: true, analysis: { $ne: null }, chain: "solana" }, { sort: { liquidityUsd: -1 } });
    if (!t) {
      await runScanCycle({ chainsPerTick: 0 });
      await runAnalysisCycle(8);
      t = await tokens.findOne({ passedFilters: true, analysis: { $ne: null }, chain: "solana" }, { sort: { liquidityUsd: -1 } });
    }
    if (!t) throw new Error("no analysed mock token available");
    token = t;

    const now = new Date();
    await (await collections.users()).insertOne({ _id: userId, email: `appr-${Date.now()}@test.local`, passwordHash: "x", name: null, role: "USER", createdAt: now });
    accountId = newId();
    await (await collections.tradingAccounts()).insertOne({ _id: accountId, userId, environment: "LIVE", realizedPnlUsd: 0, createdAt: now });
    await (await collections.wallets()).insertOne({ _id: newId(), userId, chain: "solana", address: "W".repeat(44), label: null, verifiedAt: now, createdAt: now });
    await getSettings(userId);
    // the bot's own preference gates aren't what these tests are about
    await (await collections.tradingSettings()).updateOne({ userId }, { $set: { minOpportunityScore: 0, minLiquidityUsd: 0, minVolume24hUsd: 0, maxPriceImpactPct: 50, maxAllowedRisk: "HIGH" } });
  });

  afterEach(() => vi.restoreAllMocks());

  afterAll(async () => {
    if (!dbUp || !userId) return;
    await Promise.all([
      (await collections.users()).deleteOne({ _id: userId }),
      (await collections.tradingAccounts()).deleteMany({ userId }),
      (await collections.tradingSettings()).deleteMany({ userId }),
      (await collections.wallets()).deleteMany({ userId }),
      (await collections.positions()).deleteMany({ userId }),
      (await collections.trades()).deleteMany({ userId }),
    ]).catch(() => {});
  });

  async function mockBuild(tx = "fresh-tx") {
    const { providers } = await import("@/core/providers/registry");
    return vi.spyOn(providers().dex, "buildSwapTransaction").mockResolvedValue({ unsignedTxBase64: tx });
  }

  it("refresh rebuilds a stale queued buy: fresh unsigned tx, extended expiry, bot's reason and signal preserved", async () => {
    const { refreshPreparedTrade } = await import("@/services/trading");
    const build = await mockBuild("fresh-tx");
    const id = await makeTrade({ ageMs: 10 * MIN, expiresAt: new Date(Date.now() + 5 * MIN) });
    const r = await refreshPreparedTrade(userId, id);
    expect(r.unsignedTxBase64).toBe("fresh-tx");
    expect(build).toHaveBeenCalledWith(expect.anything(), "W".repeat(44));
    const row = await (await collections.trades()).findOne({ _id: id });
    expect(row?.status).toBe("PREPARED");
    expect(row?.transaction?.unsignedTx).toBe("fresh-tx");
    expect(row!.expiresAt!.getTime()).toBeGreaterThan(Date.now() + 4 * MIN);
    expect((row!.quote as { reason?: string }).reason).toBe("bot entry");
  });

  it("refresh revives a trade the bot cycle already flipped to EXPIRED, as long as it is recent", async () => {
    const { refreshPreparedTrade } = await import("@/services/trading");
    await mockBuild();
    const id = await makeTrade({ ageMs: 20 * MIN, status: "EXPIRED", expiresAt: new Date(Date.now() - 5 * MIN) });
    await refreshPreparedTrade(userId, id);
    expect((await (await collections.trades()).findOne({ _id: id }))?.status).toBe("PREPARED");
  });

  it("refresh refuses trades that are old, already signed, or past the grace window", async () => {
    const { refreshPreparedTrade } = await import("@/services/trading");
    await mockBuild();
    const old = await makeTrade({ ageMs: 3 * 60 * MIN, status: "EXPIRED" });
    await expect(refreshPreparedTrade(userId, old)).rejects.toMatchObject({ status: 409 });
    const pending = await makeTrade({ status: "PENDING", transaction: { chain: token.chain, signature: SIG, status: "PENDING", unsignedTx: "x", error: null, slot: null, submittedAt: new Date(), confirmedAt: null, createdAt: new Date() } });
    await expect(refreshPreparedTrade(userId, pending)).rejects.toMatchObject({ status: 409 });
    await expect(refreshPreparedTrade(userId, "does-not-exist")).rejects.toMatchObject({ status: 404 });
    await expect(refreshPreparedTrade(newId(), pending)).rejects.toMatchObject({ status: 404 }); // another user's trade
  });

  it("refresh re-validates a queued buy and refuses one that no longer fits the limits", async () => {
    const { refreshPreparedTrade } = await import("@/services/trading");
    const build = await mockBuild();
    const id = await makeTrade({ inputUsd: 5_000_000 }); // far above the user's position/capital limits
    await expect(refreshPreparedTrade(userId, id)).rejects.toMatchObject({ status: 422 });
    expect(build).not.toHaveBeenCalled(); // nothing was built for the wallet to sign
  });

  it("refresh needs a linked wallet", async () => {
    const { refreshPreparedTrade } = await import("@/services/trading");
    await mockBuild();
    const wallets = await collections.wallets();
    const w = await wallets.findOne({ userId });
    await wallets.deleteMany({ userId });
    try {
      const id = await makeTrade({});
      await expect(refreshPreparedTrade(userId, id)).rejects.toMatchObject({ status: 400 });
    } finally {
      if (w) await wallets.insertOne(w);
    }
  });

  it("a signature for a trade whose quote expired while the wallet prompt was open is still recorded", async () => {
    const { executeTrade } = await import("@/services/trading");
    const { providers } = await import("@/core/providers/registry");
    vi.spyOn(providers().dex, "getTransactionStatus").mockResolvedValue({ status: "CONFIRMED", slot: 777 });
    for (const status of ["PREPARED", "EXPIRED"] as const) {
      const id = await makeTrade({ ageMs: 8 * MIN, status, expiresAt: new Date(Date.now() - 2 * MIN) });
      const sig = SIG.slice(0, 1) + (status === "PREPARED" ? "c" : "d").repeat(80); // a signature can only ever be recorded once
      const r = await executeTrade(userId, id, { signature: sig });
      expect(r).toMatchObject({ ok: true });
      const row = await (await collections.trades()).findOne({ _id: id });
      expect(row?.transaction?.signature).toBe(sig);
      expect(row?.status).not.toBe("EXPIRED");
    }
  });

  it("without a signature an expired trade is still refused, and a signature outside the grace window is refused", async () => {
    const { executeTrade } = await import("@/services/trading");
    const expired = await makeTrade({ ageMs: 8 * MIN, status: "PREPARED", expiresAt: new Date(Date.now() - MIN) });
    await expect(executeTrade(userId, expired, {})).rejects.toMatchObject({ status: 410 });
    const flipped = await makeTrade({ ageMs: 8 * MIN, status: "EXPIRED" });
    await expect(executeTrade(userId, flipped, {})).rejects.toMatchObject({ status: 409 });
    const ancient = await makeTrade({ ageMs: 3 * 60 * MIN, status: "EXPIRED" });
    await expect(executeTrade(userId, ancient, { signature: SIG })).rejects.toMatchObject({ status: 409 });
  });

  it("a malformed signature is never recorded, even inside the grace window", async () => {
    const { executeTrade } = await import("@/services/trading");
    const id = await makeTrade({ ageMs: MIN, status: "EXPIRED" });
    await expect(executeTrade(userId, id, { signature: "nonsense" })).rejects.toMatchObject({ status: 400 });
    expect((await (await collections.trades()).findOne({ _id: id }))?.transaction?.signature).toBeNull();
  });

  it("bot entries wait for approval much longer than a hand-made trade's 60s quote", async () => {
    const { prepareTrade } = await import("@/services/trading");
    await mockBuild();
    const input = { chain: "solana" as const, tokenAddress: token.address, amountUsd: 5, slippageBps: 100, environment: "LIVE" as const };
    const auto = await prepareTrade(userId, input, "AUTO_ENTRY");
    const manual = await prepareTrade(userId, input, "MANUAL_ENTRY");
    created.push(auto.trade.id, manual.trade.id);
    const ttl = (t: { trade: { expiresAt: Date | null } }) => t.trade.expiresAt!.getTime() - Date.now();
    expect(ttl(auto)).toBeGreaterThan(10 * MIN);
    expect(ttl(manual)).toBeLessThanOrEqual(MIN);
  });
});
