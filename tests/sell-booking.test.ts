/**
 * "When a token has been sold it should no longer be in open positions" and "I saw 12% before I sold, how am I seeing +2.3%".
 * A sale is booked from what the chain says it paid out. These pin: the network fee is not taken out of the proceeds (the wallet's
 * balance change already has it deducted), what was sold is costed at the price paid, "everything" that comes back a hair short of
 * the position's amount still closes it, a sale is only ever booked once however many places ask, and a confirmed sale is settled
 * when positions are listed instead of waiting for the next scheduled run.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("next/headers", () => ({ cookies: async () => ({ get: () => undefined, set: () => {}, delete: () => {} }) }));
vi.mock("@/lib/env", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/env")>()), liveTradingAllowed: () => true }));

import { applySell } from "@/core/trading/positions";
import { providers } from "@/core/providers/registry";
import { closeDb, collections, newId } from "@/lib/db";
import type { PositionDoc, TokenDoc, TradeDoc } from "@/lib/models";

describe("what a sold position cost", () => {
  it("is the tokens sold x the price paid, so a position opened with its buy fee in the cost basis reads the same as a new one", () => {
    // 100 tokens bought at $0.10 ($10 swap) plus a $1 fee that was folded into the cost basis
    const old = applySell({ entryPriceUsd: 0.1, initialAmount: 100, amount: 100, costBasisUsd: 11, targetsHit: 0, realizedPnlUsd: 0 }, 100, 11.2);
    expect(old.realizedDeltaUsd).toBeCloseTo(1.2, 10); // +12% on the $10 swap, the number that was on screen
    expect(old.closed).toBe(true);
    const half = applySell({ entryPriceUsd: 0.1, initialAmount: 100, amount: 100, costBasisUsd: 11, targetsHit: 0, realizedPnlUsd: 0 }, 50, 5.6);
    expect(half.realizedDeltaUsd).toBeCloseTo(0.6, 10);
    expect(half.costBasisUsd).toBeCloseTo(5, 10); // what is left costs its swap price, fee gone
    expect(half.amount).toBe(50);
  });
});

describe("profit and loss shows enough decimals to read on a small position", () => {
  it("fractions of a cent keep their digits; ordinary amounts don't grow a long tail", async () => {
    const { usdPnl, pnlDigits } = await import("@/lib/format");
    expect(usdPnl(0.00173)).toBe("$0.001730");
    expect(usdPnl(-0.008123)).toBe("-$0.008123");
    expect(usdPnl(0.0831)).toBe("$0.0831");
    expect(usdPnl(12.3456)).toBe("$12.3456");
    expect(usdPnl(1234.5678)).toBe("$1,234.57");
    expect(usdPnl(0)).toBe("$0.0000");
    expect(usdPnl(null)).toBe("—");
    expect(pnlDigits(0.5)).toBe(4);
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

(dbUp ? describe : describe.skip)("booking a confirmed sale", () => {
  const userId = newId();
  const WALLET = "W".repeat(44);
  const ids = { tokens: [] as string[], positions: [] as string[], trades: [] as string[] };
  let template: TokenDoc;
  let accountId = "";

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
    await (await collections.users()).insertOne({ _id: userId, email: `sellbook-${Date.now()}@test.local`, passwordHash: "x", name: null, role: "USER", createdAt: now });
    await (await collections.tradingAccounts()).insertOne({ _id: accountId, userId, environment: "LIVE", realizedPnlUsd: 0, createdAt: now });
    await (await collections.wallets()).insertOne({ _id: newId(), userId, chain: "solana", address: WALLET, label: null, verifiedAt: now, createdAt: now });
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    delete (providers().dex as unknown as { inspectTransaction?: unknown }).inspectTransaction;
  });
  afterAll(async () => {
    await Promise.all([
      (await collections.users()).deleteOne({ _id: userId }), (await collections.tradingAccounts()).deleteMany({ userId }), (await collections.wallets()).deleteMany({ userId }),
      (await collections.positions()).deleteMany({ _id: { $in: ids.positions } }), (await collections.trades()).deleteMany({ _id: { $in: ids.trades } }), (await collections.tokens()).deleteMany({ _id: { $in: ids.tokens } }),
    ]).catch(() => {});
  });

  /** an open position of `amount` tokens bought at `entry`, with `fee` of buy fee folded into the cost basis (as positions opened before the change have) */
  async function open(amount: number, entry: number, fee = 0) {
    const token = { ...template, _id: newId(), address: `Sell${newId().replace(/-/g, "")}`.slice(0, 44), symbol: "SOLD", priceUsd: entry, lastScannedAt: new Date() } as TokenDoc;
    ids.tokens.push(token._id);
    await (await collections.tokens()).insertOne(token);
    const now = new Date();
    const pos = {
      _id: newId(), userId, accountId, tokenId: token._id, environment: "LIVE", status: "OPEN", health: "HOLD", healthNotes: null, origin: "MANUAL", sourceSignalId: null,
      entryPriceUsd: entry, currentPriceUsd: entry, initialAmount: amount, amount, investedUsd: amount * entry + fee, costBasisUsd: amount * entry + fee, realizedPnlUsd: 0, targetsHit: 0,
      walletAddress: WALLET, targetsSnapshot: [{ level: 1, gainPct: 10, sellPct: 100 }], emergencyEnabled: false, emergencyAutoExit: false, openedAt: now, updatedAt: now, closedAt: null, lastAnalysisAt: null,
    } as PositionDoc;
    ids.positions.push(pos._id);
    await (await collections.positions()).insertOne(pos);
    return { token, pos };
  }

  /** a submitted sell of the whole position, plus what the chain will say it did */
  async function sell(token: TokenDoc, pos: PositionDoc, chain: { tokensOut: number; nativeDelta: number; fee: number; solUsd?: number }) {
    const now = new Date();
    const trade = {
      _id: newId(), userId, accountId, tokenId: token._id, positionId: pos._id, side: "SELL", kind: "MANUAL_EXIT", environment: "LIVE", dataSource: "LIVE", status: "PENDING",
      inputUsd: pos.amount * pos.entryPriceUsd, tokenAmount: pos.amount, priceUsd: pos.entryPriceUsd, priceImpactPct: 0.1, slippageBps: 300, feesUsd: 0, networkFeeUsd: 0.01, realizedPnlUsd: null,
      quote: { wallet: WALLET }, failureReason: null, expiresAt: null, createdAt: now, executedAt: null,
      transaction: { chain: "solana", signature: "5" + newId().replace(/-/g, "").padEnd(80, "c"), status: "PENDING", unsignedTx: "x", error: null, slot: null, submittedAt: now, confirmedAt: null, createdAt: now },
    } as TradeDoc;
    ids.trades.push(trade._id);
    await (await collections.trades()).insertOne(trade);
    vi.spyOn(providers().dex, "getTransactionStatus").mockResolvedValue({ status: "CONFIRMED", slot: 1 });
    // the mock market has no way to read a transaction back, so give it one that says what the chain reported
    (providers().dex as unknown as { inspectTransaction?: unknown }).inspectTransaction = async () => ({ signer: WALLET, tokenDelta: -chain.tokensOut, nativeDelta: chain.nativeDelta, feeNative: chain.fee });
    vi.spyOn(providers().chains.solana, "nativeUsdPrice").mockResolvedValue(chain.solUsd ?? 100);
    return trade;
  }

  it("does not take the network fee out of what the sale returned: the +12% that was on screen is the +12% booked", async () => {
    const { reconcileLiveTrade } = await import("@/services/trading");
    // 1000 tokens bought at $0.0001 = $0.10 swap, plus a $0.01 buy fee in the cost basis (the old way). SOL is $100.
    const { token, pos } = await open(1000, 0.0001, 0.01);
    // the swap pays out $0.112 (+12%) = 0.00112 SOL, but the wallet also paid a 0.0001 SOL ($0.01) fee, so its balance rose only 0.00102
    const trade = await sell(token, pos, { tokensOut: 1000, nativeDelta: 0.00102, fee: 0.0001 });
    await reconcileLiveTrade(trade._id);
    const after = await (await collections.positions()).findOne({ _id: pos._id });
    const t = await (await collections.trades()).findOne({ _id: trade._id });
    expect(t?.realizedPnlUsd).toBeCloseTo(0.012, 6); // $0.112 - $0.10: +12%, not the +2% left once both fees were taken out
    expect(after?.realizedPnlUsd).toBeCloseTo(0.012, 6);
    expect(after?.status).toBe("CLOSED");
  });

  it("everything sold closes the position even when the chain reports a hair fewer tokens than the position held", async () => {
    const { reconcileLiveTrade } = await import("@/services/trading");
    const { token, pos } = await open(14.66, 0.006823);
    const trade = await sell(token, pos, { tokensOut: 14.66 - 3e-9, nativeDelta: 0.001, fee: 0.0001 });
    await reconcileLiveTrade(trade._id);
    const after = await (await collections.positions()).findOne({ _id: pos._id });
    expect(after?.status).toBe("CLOSED");
    expect(after?.amount).toBe(0); // not 0.000000003 left over, listed as open
    expect(after?.closedAt).toBeInstanceOf(Date);
  });

  it("a part sale leaves the rest open", async () => {
    const { reconcileLiveTrade } = await import("@/services/trading");
    const { token, pos } = await open(1000, 0.0001);
    const trade = await sell(token, pos, { tokensOut: 400, nativeDelta: 0.0004, fee: 0.0001 });
    await reconcileLiveTrade(trade._id);
    const after = await (await collections.positions()).findOne({ _id: pos._id });
    expect(after?.status).not.toBe("CLOSED");
    expect(after?.amount).toBeCloseTo(600, 8);
    expect(after?.costBasisUsd).toBeCloseTo(0.06, 10);
  });

  it("is booked once however many places ask at the same moment (the wallet's confirmation, a page load, the scheduled job)", async () => {
    const { reconcileLiveTrade } = await import("@/services/trading");
    const { token, pos } = await open(1000, 0.0001);
    const trade = await sell(token, pos, { tokensOut: 1000, nativeDelta: 0.00102, fee: 0.0001 });
    const before = (await (await collections.tradingAccounts()).findOne({ _id: accountId }))!.realizedPnlUsd;
    await Promise.all([reconcileLiveTrade(trade._id), reconcileLiveTrade(trade._id), reconcileLiveTrade(trade._id)]);
    const account = await (await collections.tradingAccounts()).findOne({ _id: accountId });
    expect(account!.realizedPnlUsd - before).toBeCloseTo(0.012, 6); // once, not three times
    const events = await (await collections.positionEvents()).countDocuments({ positionId: pos._id, type: "LIVE_SELL" });
    expect(events).toBe(1);
  });

  it("a sale that has confirmed is settled when positions are listed, so a sold token doesn't sit in 'open positions' until the next run", async () => {
    const { positionViews } = await import("@/services/queries");
    const { token, pos } = await open(1000, 0.0001);
    await sell(token, pos, { tokensOut: 1000, nativeDelta: 0.00102, fee: 0.0001 });
    expect((await positionViews(userId, "LIVE")).some((p) => p.id === pos._id)).toBe(false);
    expect((await (await collections.positions()).findOne({ _id: pos._id }))?.status).toBe("CLOSED");
  });

  it("a sale that is still pending stays listed, and one that never confirms doesn't break the list", async () => {
    const { positionViews } = await import("@/services/queries");
    const { token, pos } = await open(1000, 0.0001);
    await sell(token, pos, { tokensOut: 1000, nativeDelta: 0.001, fee: 0.0001 });
    vi.spyOn(providers().dex, "getTransactionStatus").mockResolvedValue({ status: "PENDING" });
    expect((await positionViews(userId, "LIVE")).some((p) => p.id === pos._id)).toBe(true);
    vi.spyOn(providers().dex, "getTransactionStatus").mockRejectedValue(new Error("rpc down"));
    await expect(positionViews(userId, "LIVE")).resolves.toBeDefined();
  });
});
