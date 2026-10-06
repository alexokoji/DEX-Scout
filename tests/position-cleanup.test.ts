/**
 * The cleanup that closes open positions that are really over. Its first rule is to close nothing it couldn't check, so most of
 * these pin what it leaves alone; the rest pin what it closes, and that a dry run changes nothing.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("next/headers", () => ({ cookies: async () => ({ get: () => undefined, set: () => {}, delete: () => {} }) }));
vi.mock("@/lib/env", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/env")>()), liveTradingAllowed: () => true }));

import { providers } from "@/core/providers/registry";
import { closeDb, collections, newId } from "@/lib/db";
import type { PositionDoc, TokenDoc, TradeDoc } from "@/lib/models";
import { cleanUpPositions } from "@/services/positionCleanup";

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

(dbUp ? describe : describe.skip)("closing positions that are really over", () => {
  const userId = newId();
  const WALLET = "W".repeat(44);
  const ids = { tokens: [] as string[], positions: [] as string[], trades: [] as string[] };
  let template: TokenDoc;
  let accountId = "";
  /** what the "chain" says each wallet+token holds: a number, null (unreadable) or a function (changes between reads) */
  let balances = new Map<string, number | null | (() => number | null)>();
  const fast = { confirmDelayMs: 1 };

  beforeAll(async () => {
    const { runScanCycle } = await import("@/services/scanner");
    const tokens = await collections.tokens();
    let t = await tokens.findOne({ chain: "solana" });
    if (!t) {
      await runScanCycle({ chainsPerTick: 0 });
      t = await tokens.findOne({ chain: "solana" });
    }
    if (!t) throw new Error("no mock solana token available");
    template = t;
    accountId = newId();
    const now = new Date();
    await (await collections.users()).insertOne({ _id: userId, email: `cleanup-${Date.now()}@test.local`, passwordHash: "x", name: null, role: "USER", createdAt: now });
    await (await collections.tradingAccounts()).insertOne({ _id: accountId, userId, environment: "LIVE", realizedPnlUsd: 0, createdAt: now });
    (providers().chains.solana as unknown as { getTokenBalance?: unknown }).getTokenBalance = async (_owner: string, token: string) => {
      const v = balances.get(token);
      return typeof v === "function" ? v() : (v ?? null);
    };
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    balances = new Map();
    // each test starts from no open positions of its own
    await (await collections.positions()).deleteMany({ _id: { $in: ids.positions } });
    await (await collections.trades()).deleteMany({ _id: { $in: ids.trades } });
    ids.positions.length = 0;
    ids.trades.length = 0;
  });
  afterAll(async () => {
    delete (providers().chains.solana as unknown as { getTokenBalance?: unknown }).getTokenBalance;
    await Promise.all([
      (await collections.users()).deleteOne({ _id: userId }), (await collections.tradingAccounts()).deleteMany({ userId }),
      (await collections.positions()).deleteMany({ userId }), (await collections.trades()).deleteMany({ userId }), (await collections.tokens()).deleteMany({ _id: { $in: ids.tokens } }),
    ]).catch(() => {});
  });

  async function open(over: Partial<PositionDoc> = {}, balance?: number | null | (() => number | null)) {
    const token = { ...template, _id: newId(), address: `Clean${newId().replace(/-/g, "")}`.slice(0, 44), symbol: "CLN" } as TokenDoc;
    ids.tokens.push(token._id);
    await (await collections.tokens()).insertOne(token);
    const old = new Date(Date.now() - 3 * 3_600_000);
    const pos = {
      _id: newId(), userId, accountId, tokenId: token._id, environment: "LIVE", status: "OPEN", health: "HOLD", healthNotes: null, origin: "MANUAL", sourceSignalId: null,
      entryPriceUsd: 0.01, currentPriceUsd: 0.01, initialAmount: 1000, amount: 1000, investedUsd: 10, costBasisUsd: 10, realizedPnlUsd: 0, targetsHit: 0, walletAddress: WALLET,
      targetsSnapshot: [], emergencyEnabled: false, emergencyAutoExit: false, openedAt: old, updatedAt: old, closedAt: null, lastAnalysisAt: null, ...over,
    } as PositionDoc;
    ids.positions.push(pos._id);
    await (await collections.positions()).insertOne(pos);
    if (balance !== undefined) balances.set(token.address, balance);
    return { token, pos };
  }
  const status = async (id: string) => (await (await collections.positions()).findOne({ _id: id }))?.status;
  /** only this test's positions: other open positions in the shared test database aren't ours to judge */
  const mine = (r: Awaited<ReturnType<typeof cleanUpPositions>>) => ({ stale: r.stale.filter((f) => ids.positions.includes(f.positionId)), kept: r.kept.filter((k) => ids.positions.includes(k.positionId)) });

  it("closes a position the wallet no longer holds (the chain says 0, twice), without touching realised P&L; a dry run changes nothing", async () => {
    const { pos } = await open({}, 0);
    const dry = mine(await cleanUpPositions({ apply: false, ...fast }));
    expect(dry.stale.map((f) => [f.positionId, f.reason])).toEqual([[pos._id, "GONE_FROM_WALLET"]]);
    expect(await status(pos._id)).toBe("OPEN"); // dry run: nothing changed

    const before = (await (await collections.tradingAccounts()).findOne({ _id: accountId }))!.realizedPnlUsd;
    const r = await cleanUpPositions({ apply: true, ...fast });
    expect(r.closed).toBeGreaterThanOrEqual(1);
    const after = await (await collections.positions()).findOne({ _id: pos._id });
    expect(after).toMatchObject({ status: "CLOSED", amount: 0, costBasisUsd: 0 });
    expect(after?.closedAt).toBeInstanceOf(Date);
    expect((await (await collections.tradingAccounts()).findOne({ _id: accountId }))!.realizedPnlUsd).toBe(before); // no proceeds known: P&L is not invented
    const ev = await (await collections.positionEvents()).findOne({ positionId: pos._id, type: "CLEANUP_CLOSED" });
    expect(ev?.message).toMatch(/sold outside the app/);
    expect(ev?.message).toMatch(/realised P&L unchanged/);
  });

  it("closes dust: a rounding remainder of a sale isn't a holding", async () => {
    const { pos } = await open({ amount: 3e-9, initialAmount: 14.66 }, 5); // even a wallet that reports something: the position itself is a remainder
    const r = mine(await cleanUpPositions({ apply: true, ...fast }));
    expect(r.stale.map((f) => f.reason)).toEqual(["DUST"]);
    expect(await status(pos._id)).toBe("CLOSED");
  });

  it("leaves alone anything it could not check: an unreadable chain is 'unknown', never 'none left'", async () => {
    const { pos } = await open({}, null);
    const r = mine(await cleanUpPositions({ apply: true, ...fast }));
    expect(r.stale).toEqual([]);
    expect(r.kept[0].why).toMatch(/could not be read/);
    expect(await status(pos._id)).toBe("OPEN");
  });

  it("leaves a position the wallet still holds, and reports (without changing) one that holds less than recorded", async () => {
    const full = await open({}, 1000);
    const part = await open({}, 400);
    const r = mine(await cleanUpPositions({ apply: true, ...fast }));
    expect(r.stale).toEqual([]);
    expect(r.kept.find((k) => k.positionId === part.pos._id)?.why).toMatch(/holds 400 of the 1000 recorded/);
    expect(await status(full.pos._id)).toBe("OPEN");
    expect(await status(part.pos._id)).toBe("OPEN");
    expect((await (await collections.positions()).findOne({ _id: part.pos._id }))?.amount).toBe(1000); // not adjusted
  });

  it("doesn't believe a single 'none': if the second read finds tokens, or can't read, it leaves the position", async () => {
    let n = 0;
    const flaky = await open({}, () => (n++ === 0 ? 0 : 250)); // 0 then 250
    const down = await open({}, (() => { let k = 0; return () => (k++ === 0 ? 0 : null); })());
    const r = mine(await cleanUpPositions({ apply: true, ...fast }));
    expect(r.stale).toEqual([]);
    expect(r.kept.find((k) => k.positionId === flaky.pos._id)?.why).toMatch(/changed between two reads/);
    expect(r.kept.find((k) => k.positionId === down.pos._id)?.why).toMatch(/second look/);
    expect(await status(flaky.pos._id)).toBe("OPEN");
    expect(await status(down.pos._id)).toBe("OPEN");
  });

  it("doesn't judge a position opened a moment ago, one with no wallet recorded, or one with a sale still pending", async () => {
    const fresh = await open({ openedAt: new Date() }, 0);
    const noWallet = await open({ walletAddress: null }, 0);
    const pendingSale = await open({}, 0);
    const now = new Date();
    const trade = {
      _id: newId(), userId, accountId, tokenId: pendingSale.token._id, positionId: pendingSale.pos._id, side: "SELL", kind: "MANUAL_EXIT", environment: "LIVE", dataSource: "LIVE", status: "PENDING",
      inputUsd: 10, tokenAmount: 1000, priceUsd: 0.01, priceImpactPct: 0, slippageBps: 300, feesUsd: 0, networkFeeUsd: 0, realizedPnlUsd: null, quote: { wallet: WALLET }, failureReason: null, expiresAt: null, createdAt: now, executedAt: null,
      transaction: { chain: "solana", signature: "5" + "d".repeat(80), status: "PENDING", unsignedTx: "x", error: null, slot: null, submittedAt: now, confirmedAt: null, createdAt: now },
    } as TradeDoc;
    ids.trades.push(trade._id);
    await (await collections.trades()).insertOne(trade);
    vi.spyOn(providers().dex, "getTransactionStatus").mockResolvedValue({ status: "PENDING" }); // not confirmed yet
    const r = mine(await cleanUpPositions({ apply: true, ...fast }));
    expect(r.stale).toEqual([]);
    for (const p of [fresh, noWallet, pendingSale]) expect(await status(p.pos._id)).toBe("OPEN");
  });

  it("books a sale the chain has confirmed through the normal path (proceeds and P&L recorded), instead of closing it blind", async () => {
    const { pos, token } = await open({}, 0);
    const now = new Date();
    const trade = {
      _id: newId(), userId, accountId, tokenId: token._id, positionId: pos._id, side: "SELL", kind: "MANUAL_EXIT", environment: "LIVE", dataSource: "LIVE", status: "PENDING",
      inputUsd: 12, tokenAmount: 1000, priceUsd: 0.012, priceImpactPct: 0, slippageBps: 300, feesUsd: 0, networkFeeUsd: 0.01, realizedPnlUsd: null, quote: { wallet: WALLET }, failureReason: null, expiresAt: null, createdAt: now, executedAt: null,
      transaction: { chain: "solana", signature: "5" + "e".repeat(80), status: "PENDING", unsignedTx: "x", error: null, slot: null, submittedAt: now, confirmedAt: null, createdAt: now },
    } as TradeDoc;
    ids.trades.push(trade._id);
    await (await collections.trades()).insertOne(trade);
    vi.spyOn(providers().dex, "getTransactionStatus").mockResolvedValue({ status: "CONFIRMED", slot: 9 });
    const dry = await cleanUpPositions({ apply: false, ...fast });
    expect(dry.pendingConfirmable).toBeGreaterThanOrEqual(1);
    expect((await (await collections.trades()).findOne({ _id: trade._id }))?.status).toBe("PENDING"); // dry run: not booked
    const r = await cleanUpPositions({ apply: true, ...fast });
    expect(r.settledTrades).toBeGreaterThanOrEqual(1);
    const after = await (await collections.positions()).findOne({ _id: pos._id });
    expect(after?.status).toBe("CLOSED");
    expect(after?.realizedPnlUsd).toBeCloseTo(12 - 1000 * 0.01, 6); // proceeds booked, not skipped: $12 for $10 of tokens
  });

  it("a position closed in the meantime isn't closed twice", async () => {
    const { pos } = await open({}, 0);
    const first = await cleanUpPositions({ apply: true, ...fast });
    const second = await cleanUpPositions({ apply: true, ...fast });
    expect(first.closed).toBeGreaterThanOrEqual(1);
    expect(mine(second).stale).toEqual([]);
    expect(await (await collections.positionEvents()).countDocuments({ positionId: pos._id, type: "CLEANUP_CLOSED" })).toBe(1);
  });
});
