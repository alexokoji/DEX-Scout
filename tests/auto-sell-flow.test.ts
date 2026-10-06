/**
 * Auto-sell end to end against the embedded MongoDB: a buy confirms → sell orders are suggested → the user arms them →
 * the venue reports fills → profit is booked into the position and notified. The two venues' network calls are mocked
 * with the response shapes captured from the real services.
 */
import { randomBytes } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("next/headers", () => ({ cookies: async () => ({ get: () => undefined, set: () => {}, delete: () => {} }) }));
vi.mock("@/lib/env", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/env")>()), liveTradingAllowed: () => true }));
vi.mock("@/core/providers/evm/evmProviders", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/core/providers/evm/evmProviders")>()), tokenDecimals: async () => 18 }));
vi.mock("@/core/providers/solana/solanaProviders", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/core/providers/solana/solanaProviders")>()), mintDecimals: async () => 6 }));
vi.mock("@/core/providers/limitOrders/cow", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/core/providers/limitOrders/cow")>()),
  cowAllowance: vi.fn(async () => BigInt(0)),
  submitCowOrder: vi.fn(async (_c: string, _o: unknown, _w: string, sig: string) => "0xuid" + sig.slice(2, 10)),
  getCowOrder: vi.fn(),
  getCowTradeHashes: vi.fn(async () => ["0x" + "cd".repeat(32)]),
  cancelCowOrders: vi.fn(async () => undefined),
}));
vi.mock("@/core/providers/limitOrders/kyber", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/core/providers/limitOrders/kyber")>()),
  kyberContract: vi.fn(async () => "0xcab2FA2eeab7065B45CBcF6E3936dDE2506b4f6C"),
  erc20Allowance: vi.fn(async () => BigInt(0)),
  kyberSignMessage: vi.fn(async (req: { chainId: string }) => ({
    types: { EIP712Domain: [{ name: "name", type: "string" }], Order: [{ name: "salt", type: "uint256" }] },
    domain: { name: "Kyber DSLO Protocol", version: "1", chainId: Number(req.chainId), verifyingContract: "0xcab2FA2eeab7065B45CBcF6E3936dDE2506b4f6C" },
    primaryType: "Order",
    message: { salt: "12345678901234567890" },
  })),
  submitKyberOrder: vi.fn(async () => ({ id: null as number | null })),
  kyberFindOrder: vi.fn(),
  kyberCancelSign: vi.fn(async () => ({ types: {}, domain: {}, primaryType: "CancelOrder", message: { orderIds: [777] } })),
  cancelKyberOrders: vi.fn(async () => undefined),
}));
vi.mock("@/core/providers/limitOrders/jupiter", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/core/providers/limitOrders/jupiter")>()),
  // behaves like Jupiter's order builder (measured live): it refuses an order that pays out under 5 USD, in these words, and says what it measured
  createJupiterOrder: vi.fn(async (a: { takingRaw: bigint }) => {
    const usd = (Number(a.takingRaw) / 1e9) * 150; // the mock market's SOL price
    if (usd < 5) throw new Error(`Invalid create order request: Order size must be at least 5 USD, received: ${usd}`);
    return { order: "OrderPubkey1111111111111111111111111111111111", requestId: "r", transaction: "dHg=" };
  }),
  getJupiterOrder: vi.fn(),
  cancelJupiterOrder: vi.fn(async () => "Y2FuY2Vs"),
}));

import * as cow from "@/core/providers/limitOrders/cow";
import * as jup from "@/core/providers/limitOrders/jupiter";
import * as kyber from "@/core/providers/limitOrders/kyber";
import { closeDb, collections, newId } from "@/lib/db";
import type { AutoSellOrderDoc, NotificationType, PositionDoc, TokenDoc } from "@/lib/models";

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

const SIG = (c: string) => "0x" + c.repeat(130);
const uniqueSig = () => "0x" + randomBytes(65).toString("hex"); // distinct per order, like real signatures
const SOLSIG = "5" + "a".repeat(80);
const E18 = BigInt("1000000000000000000");

(dbUp ? describe : describe.skip)("auto-sell flow", () => {
  const userId = newId();
  const created = { tokens: [] as string[], positions: [] as string[] };
  let template: TokenDoc;
  let accountId = "";

  const mine = async (type?: NotificationType) => (await collections.notifications()).find({ userId, ...(type ? { type } : {}) }).sort({ createdAt: 1 }).toArray();
  const orders = async (positionId: string) => (await collections.autoSellOrders()).find({ positionId }).sort({ gainPct: 1 }).toArray();

  async function makeToken(chain: string, priceUsd: number): Promise<TokenDoc> {
    const _id = newId();
    created.tokens.push(_id);
    const t = { ...template, _id, chain, address: chain === "solana" ? `Sol${_id.replace(/-/g, "")}`.slice(0, 44) : `0x${_id.replace(/-/g, "")}00000000`.slice(0, 42), symbol: "AUTO", priceUsd, passedFilters: true, lastScannedAt: new Date() } as TokenDoc;
    await (await collections.tokens()).insertOne(t);
    return t;
  }
  async function makePosition(token: TokenDoc, over: Partial<PositionDoc> = {}): Promise<PositionDoc> {
    const _id = newId();
    created.positions.push(_id);
    const now = new Date();
    const p = {
      _id, userId, accountId, tokenId: token._id, environment: "LIVE", status: "OPEN", health: "HOLD", healthNotes: null, origin: "MANUAL", sourceSignalId: null,
      entryPriceUsd: 0.01, currentPriceUsd: 0.01, initialAmount: 10_000, amount: 10_000, investedUsd: 100, costBasisUsd: 100, realizedPnlUsd: 0, targetsHit: 0,
      targetsSnapshot: [{ level: 1, gainPct: 8, sellPct: 25 }, { level: 2, gainPct: 15, sellPct: 25 }, { level: 3, gainPct: 25, sellPct: 25 }, { level: 4, gainPct: 40, sellPct: 100 }],
      emergencyEnabled: false, emergencyAutoExit: false, openedAt: now, updatedAt: now, closedAt: null, lastAnalysisAt: null, ...over,
    } as PositionDoc;
    await (await collections.positions()).insertOne(p);
    return p;
  }

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
    const now = new Date();
    await (await collections.users()).insertOne({ _id: userId, email: `as-${Date.now()}@test.local`, passwordHash: "x", name: null, role: "USER", createdAt: now });
    accountId = newId();
    await (await collections.tradingAccounts()).insertOne({ _id: accountId, userId, environment: "LIVE", realizedPnlUsd: 0, createdAt: now });
    await (await collections.wallets()).insertMany([
      { _id: newId(), userId, chain: "evm", address: "0x" + "1".repeat(40), label: null, verifiedAt: now, createdAt: now },
      { _id: newId(), userId, chain: "solana", address: "W".repeat(44), label: null, verifiedAt: now, createdAt: now },
    ]);
  });

  afterEach(() => {
    vi.clearAllMocks();
    vi.mocked(cow.cowAllowance).mockResolvedValue(BigInt(0));
  });
  afterAll(async () => {
    await Promise.all([
      (await collections.users()).deleteOne({ _id: userId }), (await collections.tradingAccounts()).deleteMany({ userId }), (await collections.wallets()).deleteMany({ userId }),
      (await collections.positions()).deleteMany({ userId }), (await collections.trades()).deleteMany({ userId }), (await collections.notifications()).deleteMany({ userId }),
      (await collections.autoSellOrders()).deleteMany({ userId }), (await collections.tokens()).deleteMany({ _id: { $in: created.tokens } }),
    ]).catch(() => {});
  });

  it("EVM: arming returns one typed order per target plus an exact-amount approval; re-preparing replaces the suggestion", async () => {
    const { prepareArmEvm } = await import("@/services/autoSell");
    const token = await makeToken("base", 0.01);
    const pos = await makePosition(token);
    const a = await prepareArmEvm(userId, pos._id);
    expect(a.venue).toBe("cow");
    expect(a.chainId).toBe(8453);
    expect(a.orders.map((o) => o.gainPct)).toEqual([8, 15, 25, 40]);
    expect(a.approval?.to.toLowerCase()).toBe(token.address);
    expect(a.orders[0].typedData.message).toMatchObject({ kind: "sell", partiallyFillable: false, feeAmount: "0", buyToken: "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE" });
    // 2500 tokens (shaved by 1e-9) for at least 2500 * 0.0108 / 3000 ETH
    const first = a.orders[0].typedData.message as { sellAmount: string; buyAmount: string };
    expect(BigInt(first.sellAmount)).toBe((BigInt(2500) * E18 * BigInt(999_999_999)) / BigInt(1_000_000_000));
    expect(Number(BigInt(first.buyAmount)) / 1e18).toBeCloseTo((2500 * 0.0108) / 3000, 9);
    expect((await orders(pos._id)).filter((o) => o.status === "SUGGESTED")).toHaveLength(4);
    await prepareArmEvm(userId, pos._id);
    expect((await orders(pos._id)).filter((o) => o.status === "SUGGESTED")).toHaveLength(4); // replaced, not duplicated
    // no approval needed when the allowance already covers it
    vi.mocked(cow.cowAllowance).mockResolvedValue(BigInt(10) ** BigInt(30));
    expect((await prepareArmEvm(userId, pos._id)).approval).toBeNull();
  });

  it("EVM: activation rebuilds each order from stored data, posts it, and records the uid; bad or missing signatures fail only their own order", async () => {
    const { prepareArmEvm, activateEvm } = await import("@/services/autoSell");
    const token = await makeToken("base", 0.01);
    const pos = await makePosition(token);
    const a = await prepareArmEvm(userId, pos._id);
    vi.mocked(cow.submitCowOrder).mockImplementation(async (_c, _o, _w, sig) => (sig === SIG("d") ? Promise.reject(new Error("InsufficientAllowance: not enough allowance")) : "0xuid" + sig.slice(2, 8)));
    const signatures = { [a.orders[0].id]: SIG("a"), [a.orders[1].id]: SIG("b"), [a.orders[2].id]: SIG("d"), [a.orders[3].id]: "garbage" };
    const r = await activateEvm(userId, pos._id, signatures);
    expect(r.activated).toHaveLength(2);
    expect(r.failed.map((f) => f.id).sort()).toEqual([a.orders[2].id, a.orders[3].id].sort());
    const docs = await orders(pos._id);
    expect(docs.filter((d) => d.status === "ACTIVE").map((d) => d.orderRef)).toEqual(["0xuidaaaaaa", "0xuidbbbbbb"]);
    expect(docs.find((d) => d._id === a.orders[2].id)?.error).toContain("InsufficientAllowance");
    // what was posted is the stored order, whatever the client sent
    const posted = vi.mocked(cow.submitCowOrder).mock.calls[0];
    expect(posted[1]).toMatchObject({ sellToken: expect.stringMatching(new RegExp(token.address, "i")), sellAmount: docs[0].sellAmountRaw, buyAmount: docs[0].minBuyRaw, kind: "sell" });
    expect(posted[2].toLowerCase()).toBe("0x" + "1".repeat(40));
    // armed: it cannot be re-armed over the top
    await expect(prepareArmEvm(userId, pos._id)).rejects.toMatchObject({ status: 409 });
  });

  /** earlier tests leave armed orders behind; a sync looks at every armed order, so park those first */
  const isolate = async () => (await collections.autoSellOrders()).updateMany({ userId, status: "ACTIVE" }, { $set: { status: "SUPERSEDED" } });

  async function armAll(token: TokenDoc, over: Partial<PositionDoc> = {}) {
    await isolate();
    const { prepareArmEvm, activateEvm } = await import("@/services/autoSell");
    const pos = await makePosition(token, over);
    const a = await prepareArmEvm(userId, pos._id);
    await activateEvm(userId, pos._id, Object.fromEntries(a.orders.map((o) => [o.id, uniqueSig()])));
    return pos;
  }
  const fulfilled = (sellTokens: number, ethOut: number) => ({ status: "fulfilled", executedSellAmount: (BigInt(Math.round(sellTokens)) * E18).toString(), executedBuyAmount: BigInt(Math.round(ethOut * 1e12) * 1e6).toString() });

  it("EVM: a fill books the sale into the position and notifies the profit percentage; syncing again adds nothing", async () => {
    const { syncAutoSells } = await import("@/services/autoSell");
    const token = await makeToken("base", 0.0108);
    const pos = await armAll(token);
    const first = (await orders(pos._id))[0]; // +8%: 2500 tokens
    // the order sold ~2500 tokens for 0.009 ETH = $27 at $3000/ETH (cost basis of that slice was $25)
    vi.mocked(cow.getCowOrder).mockImplementation(async (_c, uid) => (uid === first.orderRef ? fulfilled(2500 * 0.999999999, 0.009) : { status: "open", executedSellAmount: "0", executedBuyAmount: "0" }));
    const r = await syncAutoSells();
    expect(r.booked).toBe(1);
    const after = (await (await collections.positions()).findOne({ _id: pos._id }))!;
    expect(after.amount).toBeCloseTo(7500, 3);
    expect(after.targetsHit).toBe(1);
    expect(after.realizedPnlUsd).toBeCloseTo(2, 1); // $27 proceeds - $25 cost
    const sale = (await (await collections.trades()).find({ positionId: pos._id, side: "SELL" }).toArray())[0];
    expect(sale).toMatchObject({ status: "CONFIRMED", kind: "TARGET_EXIT" });
    expect(sale.transaction?.signature).toBe("0x" + "cd".repeat(32));
    const n = await mine("PROFIT_TAKEN");
    expect(n).toHaveLength(1);
    expect(n[0].title).toBe("Profit taken: AUTO +8.0%");
    expect(n[0].body).toContain("Your auto-sell order filled.");
    expect((await orders(pos._id))[0].status).toBe("FILLED");
    // idempotent: the same state a minute later changes nothing
    expect((await syncAutoSells()).booked).toBe(0);
    expect((await (await collections.positions()).findOne({ _id: pos._id }))!.amount).toBeCloseTo(7500, 3);
    expect(await mine("PROFIT_TAKEN")).toHaveLength(1);
  });

  it("EVM: when every order fills the position closes, with the overall result in the notification", async () => {
    const { syncAutoSells } = await import("@/services/autoSell");
    await (await collections.notifications()).deleteMany({ userId });
    const token = await makeToken("base", 0.0108);
    const pos = await armAll(token);
    const docs = await orders(pos._id);
    vi.mocked(cow.getCowOrder).mockImplementation(async (_c, uid) => {
      const d = docs.find((x) => x.orderRef === uid)!;
      return fulfilled(d.sellAmount * 0.999999999, (d.sellAmount * d.targetPriceUsd) / 3000);
    });
    await syncAutoSells();
    const after = (await (await collections.positions()).findOne({ _id: pos._id }))!;
    expect(after.status).toBe("CLOSED");
    expect(after.amount).toBe(0);
    const n = await mine("PROFIT_TAKEN");
    expect(n).toHaveLength(4);
    expect(n[3].body).toContain("Position closed:");
    expect(n[3].body).toMatch(/\+\d+\.\d% overall/);
    expect(after.realizedPnlUsd).toBeGreaterThan(20);
  });

  it("a partial fill books only the part executed, and the rest later", async () => {
    const { syncAutoSells } = await import("@/services/autoSell");
    const token = await makeToken("base", 0.0108);
    const pos = await armAll(token);
    const first = (await orders(pos._id))[0];
    vi.mocked(cow.getCowOrder).mockImplementation(async (_c, uid) => (uid === first.orderRef ? { ...fulfilled(1000, 0.0036), status: "open" } : { status: "open", executedSellAmount: "0", executedBuyAmount: "0" }));
    await syncAutoSells();
    expect((await (await collections.positions()).findOne({ _id: pos._id }))!.amount).toBeCloseTo(9000, 3);
    expect((await orders(pos._id))[0].status).toBe("ACTIVE"); // still working
    vi.mocked(cow.getCowOrder).mockImplementation(async (_c, uid) => (uid === first.orderRef ? fulfilled(2500 * 0.999999999, 0.009) : { status: "open", executedSellAmount: "0", executedBuyAmount: "0" }));
    await syncAutoSells();
    expect((await (await collections.positions()).findOne({ _id: pos._id }))!.amount).toBeCloseTo(7500, 3); // not 6500: the first 1000 were not counted twice
  });

  it("orders that expire, get cancelled elsewhere, or vanish are closed out and the user is told", async () => {
    const { syncAutoSells } = await import("@/services/autoSell");
    await isolate();
    await (await collections.notifications()).deleteMany({ userId });
    const token = await makeToken("base", 0.0108);
    const pos = await armAll(token);
    const docs = await orders(pos._id);
    vi.mocked(cow.getCowOrder).mockImplementation(async (_c, uid) => {
      if (uid === docs[0].orderRef) return { status: "expired", executedSellAmount: "0", executedBuyAmount: "0" };
      if (uid === docs[1].orderRef) return { status: "cancelled", executedSellAmount: "0", executedBuyAmount: "0" };
      if (uid === docs[2].orderRef) return null; // unknown to CoW, but only just placed: give it time
      return { status: "open", executedSellAmount: "0", executedBuyAmount: "0" };
    });
    await syncAutoSells();
    let now = await orders(pos._id);
    expect(now.map((d) => d.status)).toEqual(["EXPIRED", "CANCELLED", "ACTIVE", "ACTIVE"]);
    expect((await mine("AUTOSELL_PROBLEM")).length).toBeGreaterThanOrEqual(1);
    await (await collections.autoSellOrders()).updateOne({ _id: docs[2]._id }, { $set: { activatedAt: new Date(Date.now() - 30 * 60_000) } });
    await syncAutoSells();
    now = await orders(pos._id);
    expect(now[2].status).toBe("FAILED");
    expect(now[2].error).toMatch(/no longer known/);
  });

  it("the monitor leaves covered targets to the armed orders, but still queues a sell for any target no order covers", async () => {
    const { monitorPosition } = await import("@/services/positionMonitor");
    const { providers } = await import("@/core/providers/registry");
    const token = await makeToken("base", 0.02); // +100%: past every target
    const pos = await armAll(token);
    const col = await collections.autoSellOrders();
    vi.spyOn(providers().dex, "buildSwapTransaction").mockResolvedValue({ unsignedTxBase64: "unsigned" });
    vi.spyOn(providers().dex, "getQuote").mockImplementation(async (req) => ({ chain: req.chain, inputMint: "a", outputMint: "b", inputAmountUsd: 1, outputAmount: 1, effectivePriceUsd: 0.02, priceImpactPct: 0.2, slippageBps: 300, minReceived: 1, networkFeeUsd: 0.01, priorityFeeUsd: 0, platformFeeUsd: 0, route: [], expiresAt: new Date(Date.now() + 60_000), raw: null, source: "LIVE" }) as never);
    vi.spyOn(providers().data, "getSnapshot").mockImplementation(async () => ({ ...template, chain: token.chain, address: token.address, priceUsd: 0.02, liquidityUsd: 900_000, liquidity1hAgoUsd: 900_000, poolCreatedAt: new Date(), observedAt: new Date() }) as never);
    const run = async () => monitorPosition((await (await collections.positions()).findOne({ _id: pos._id }))!, (await (await collections.tokens()).findOne({ _id: token._id }))!);
    const queued = async () => (await collections.trades()).countDocuments({ positionId: pos._id, side: "SELL", status: "PREPARED" });
    await run();
    expect(await queued()).toBe(0); // all four targets are covered by armed orders
    // two orders failed: their targets are no longer protected, so the monitor asks the user to sign those sells
    await col.updateMany({ positionId: pos._id, gainPct: { $in: [25, 40] } }, { $set: { status: "FAILED" } });
    await run();
    expect(await queued()).toBe(1);
    vi.restoreAllMocks();
  });

  it("an armed order the market has stayed past without it filling: the second check queues a sell for the user; dropping back clears it; a closed position is never reopened by the monitor", async () => {
    const { monitorPosition } = await import("@/services/positionMonitor");
    const { providers } = await import("@/core/providers/registry");
    const token = await makeToken("base", 0.0108); // +8% on a 0.01 entry: exactly at the first target
    const pos = await armAll(token, { targetsSnapshot: [{ level: 1, gainPct: 8, sellPct: 100 }] });
    const col = await collections.autoSellOrders();
    let price = 0.0108;
    vi.spyOn(providers().dex, "buildSwapTransaction").mockResolvedValue({ unsignedTxBase64: "unsigned" });
    vi.spyOn(providers().dex, "getQuote").mockImplementation(async (req) => ({ chain: req.chain, inputMint: "a", outputMint: "b", inputAmountUsd: 1, outputAmount: 1, effectivePriceUsd: price, priceImpactPct: 0.2, slippageBps: 300, minReceived: 1, networkFeeUsd: 0.01, priorityFeeUsd: 0, platformFeeUsd: 0, route: [], expiresAt: new Date(Date.now() + 60_000), raw: null, source: "LIVE" }) as never);
    vi.spyOn(providers().data, "getSnapshot").mockImplementation(async () => ({ ...template, chain: token.chain, address: token.address, priceUsd: price, liquidityUsd: 900_000, liquidity1hAgoUsd: 900_000, poolCreatedAt: new Date(), observedAt: new Date() }) as never);
    const snapshotOf = async () => (await (await collections.positions()).findOne({ _id: pos._id }))!;
    const run = async (p?: PositionDoc) => monitorPosition(p ?? (await snapshotOf()), (await (await collections.tokens()).findOne({ _id: token._id }))!);
    const queued = async () => (await collections.trades()).countDocuments({ positionId: pos._id, side: "SELL", status: "PREPARED" });
    const order = async () => (await col.findOne({ positionId: pos._id, status: "ACTIVE" }))!;

    await run();
    expect(await queued()).toBe(0); // first sight of the target: the order gets its chance
    expect((await order()).targetSeenAt).toBeTruthy();
    price = 0.0100; // back under the target: the mark clears, so a later touch starts again
    await run();
    expect((await order()).targetSeenAt ?? null).toBeNull();
    price = 0.0108;
    await run();
    expect(await queued()).toBe(0);
    await run(); // still at the target on the next check and the order hasn't filled
    expect(await queued()).toBe(1);
    const sell = await (await collections.trades()).findOne({ positionId: pos._id, side: "SELL", status: "PREPARED" });
    expect((sell!.quote as { reason: string }).reason).toMatch(/hasn't filled/);
    await run();
    expect(await queued()).toBe(1); // asking again while one is waiting adds nothing

    // the position closes (a sale booked) while a check that read it earlier is still running: its write must not undo that
    const stale = await snapshotOf();
    await (await collections.positions()).updateOne({ _id: pos._id }, { $set: { status: "CLOSED", amount: 0, closedAt: new Date() } });
    await run(stale);
    expect((await snapshotOf()).status).toBe("CLOSED");
    vi.restoreAllMocks();
  });

  it("a position that already has a close time but an open-looking status (caught by that race) is put right", async () => {
    const { healClosedPositions } = await import("@/services/trading");
    const token = await makeToken("base", 0.01);
    const pos = await makePosition(token, { status: "PROFITABLE", amount: 0, closedAt: new Date() });
    const open = await makePosition(token);
    expect(await healClosedPositions(userId)).toBeGreaterThanOrEqual(1);
    const positions = await collections.positions();
    expect((await positions.findOne({ _id: pos._id }))!.status).toBe("CLOSED");
    expect((await positions.findOne({ _id: open._id }))!.status).toBe("OPEN"); // an open one is left alone
  });

  it("cancelling: EVM takes one signature for all orders; Solana one transaction per order", async () => {
    const { prepareCancelEvm, confirmCancelEvm, prepareCancelSolana, confirmCancelSolana } = await import("@/services/autoSell");
    const token = await makeToken("base", 0.0108);
    const pos = await armAll(token);
    const c = await prepareCancelEvm(userId, pos._id);
    expect(c.typedData.message.orderUids).toHaveLength(4);
    expect(c.chainId).toBe(8453);
    expect((await confirmCancelEvm(userId, pos._id, SIG("c"))).cancelled).toBe(4);
    expect(vi.mocked(cow.cancelCowOrders)).toHaveBeenCalledWith("base", expect.any(Array), SIG("c"));
    expect((await orders(pos._id)).every((d) => d.status === "CANCELLED")).toBe(true);
    await expect(confirmCancelEvm(userId, pos._id, "nope")).rejects.toMatchObject({ status: 400 });

    const sol = await makeToken("solana", 0.01);
    const sp = await makePosition(sol, { initialAmount: 10_000, amount: 10_000 });
    const { prepareArmSolanaPlan, prepareSolanaOrder, activateSolana } = await import("@/services/autoSell");
    const plan = await prepareArmSolanaPlan(userId, sp._id);
    for (const o of plan.orders) {
      expect((await prepareSolanaOrder(userId, o.id)).unsignedTxBase64).toBe("dHg=");
      await activateSolana(userId, o.id, SOLSIG);
    }
    const active = (await orders(sp._id)).filter((d) => d.status === "ACTIVE");
    expect(active.length).toBe(plan.orders.length);
    expect((await prepareCancelSolana(userId, active[0]._id)).unsignedTxBase64).toBe("Y2FuY2Vs");
    await confirmCancelSolana(userId, active[0]._id, SOLSIG);
    expect((await orders(sp._id)).find((d) => d._id === active[0]._id)?.status).toBe("CANCELLED");
  });

  it("Solana: small positions merge targets into fewer orders; the minimum is learned from Jupiter's own refusal, not kept here, and one too small gets none", async () => {
    const { prepareArmSolanaPlan } = await import("@/services/autoSell");
    const sol = await makeToken("solana", 0.0005); // 10,000 tokens = $5 now, $5.40 at the first target: one order (Jupiter counts the payout at the target price), not four
    const pos = await makePosition(sol, { entryPriceUsd: 0.0005, currentPriceUsd: 0.0005 }); // bought at today's price
    const plan = await prepareArmSolanaPlan(userId, pos._id);
    expect(plan.orders).toHaveLength(1);
    expect(plan.orders[0].levels).toEqual([1, 2, 3, 4]);
    expect(plan.orders[0].gainPct).toBe(8);
    expect(plan.note).toMatch(/merged/);
    expect(plan.note).toMatch(/at least \$5 each/); // the figure came from Jupiter's message, not from the code
    const tiny = await makePosition(await makeToken("solana", 0.0001), { entryPriceUsd: 0.0001, currentPriceUsd: 0.0001 }); // $1
    await expect(prepareArmSolanaPlan(userId, tiny._id)).rejects.toMatchObject({ status: 422 });
    // a $10 position: each pair of targets pays out over $5 at its first target, so two orders
    const ten = await prepareArmSolanaPlan(userId, (await makePosition(await makeToken("solana", 0.001), { entryPriceUsd: 0.001, currentPriceUsd: 0.001 }))._id);
    expect(ten.orders.map((o) => o.levels)).toEqual([[1, 2], [3, 4]]);
    // and a refusal says whose rule it is
    await expect(prepareArmSolanaPlan(userId, tiny._id)).rejects.toThrow(/Jupiter's, not this app's/);
  });

  it("Solana: a completed order (real Jupiter history shape) is booked; one that never landed fails after the grace period", async () => {
    const { prepareArmSolanaPlan, prepareSolanaOrder, activateSolana, syncAutoSells } = await import("@/services/autoSell");
    await isolate();
    const sol = await makeToken("solana", 0.0005);
    const pos = await makePosition(sol, { entryPriceUsd: 0.0005, currentPriceUsd: 0.0005 }); // $5 -> one order for all 10,000 tokens at +8%
    const plan = await prepareArmSolanaPlan(userId, pos._id);
    await prepareSolanaOrder(userId, plan.orders[0].id);
    await activateSolana(userId, plan.orders[0].id, SOLSIG);
    const doc = (await orders(pos._id))[0] as AutoSellOrderDoc;
    // 10,000 tokens (6 decimals) sold; 0.0045 SOL out ($0.0045 * 150 = $0.675) minus Jupiter's fee
    const filled: jup.JupOrder = {
      orderKey: doc.orderRef!, status: "Completed", rawMakingAmount: "10000000000", rawRemainingMakingAmount: "0",
      trades: [{ action: "Fill", rawInputAmount: String(Math.round(10_000 * 0.999999999 * 1e6)), rawOutputAmount: "90000000", rawFeeAmount: "720000", feeMint: jup.WSOL, outputMint: jup.WSOL, txId: "JupFillTx1" }],
    };
    vi.mocked(jup.getJupiterOrder).mockResolvedValue(filled);
    await syncAutoSells();
    const after = (await (await collections.positions()).findOne({ _id: pos._id }))!;
    expect(after.status).toBe("CLOSED");
    expect((await orders(pos._id))[0].status).toBe("FILLED");
    const sale = (await (await collections.trades()).find({ positionId: pos._id, side: "SELL" }).toArray())[0];
    expect(sale.transaction?.signature).toBe("JupFillTx1");
    expect(sale.inputUsd).toBeCloseTo(((90_000_000 - 720_000) / 1e9) * 150, 4); // proceeds after Jupiter's fee, at the mock SOL price

    // an order whose transaction never landed
    const pos2 = await makePosition(await makeToken("solana", 0.001));
    const plan2 = await prepareArmSolanaPlan(userId, pos2._id);
    await prepareSolanaOrder(userId, plan2.orders[0].id);
    await activateSolana(userId, plan2.orders[0].id, SOLSIG);
    vi.mocked(jup.getJupiterOrder).mockResolvedValue(null);
    await syncAutoSells();
    expect((await orders(pos2._id))[0].status).toBe("ACTIVE"); // just placed: Jupiter may not list it yet
    await (await collections.autoSellOrders()).updateOne({ positionId: pos2._id }, { $set: { activatedAt: new Date(Date.now() - 10 * 60_000) } });
    await syncAutoSells();
    const failed = (await orders(pos2._id))[0];
    expect(failed.status).toBe("FAILED");
    expect(failed.error).toMatch(/never landed/);
  });

  it("Kyber chains (e.g. Optimism): approval goes to Kyber's contract, the order is signed as Kyber built it, the salt is kept and posted back unchanged", async () => {
    const { prepareArmEvm, activateEvm } = await import("@/services/autoSell");
    const token = await makeToken("optimism", 0.01);
    const pos = await makePosition(token);
    const a = await prepareArmEvm(userId, pos._id);
    expect(a.venue).toBe("kyber");
    expect(a.chainId).toBe(10);
    expect(a.orders).toHaveLength(4);
    expect(a.approval?.to.toLowerCase()).toBe(token.address);
    expect(a.note).toMatch(/wrapped/);
    // what Kyber was asked to build: sell the token for the chain's WRAPPED coin, at the stored amounts and expiry
    const asked = vi.mocked(kyber.kyberSignMessage).mock.calls[0][0];
    expect(asked).toMatchObject({ chainId: "10", makerAsset: token.address, takerAsset: "0x4200000000000000000000000000000000000006", maker: "0x" + "1".repeat(40) });
    const stored = (await orders(pos._id))[0];
    expect(asked.makingAmount).toBe(stored.sellAmountRaw);
    expect(asked.takingAmount).toBe(stored.minBuyRaw);
    expect(stored.venueData).toMatchObject({ salt: "12345678901234567890", takerAsset: "0x4200000000000000000000000000000000000006", expiredAt: asked.expiredAt });
    // arming: posted with the stored salt and the same fields, whatever the browser sends
    const r = await activateEvm(userId, pos._id, Object.fromEntries(a.orders.map((o) => [o.id, uniqueSig()])));
    expect(r.activated).toHaveLength(4);
    const [req, salt] = vi.mocked(kyber.submitKyberOrder).mock.calls[0];
    expect(salt).toBe("12345678901234567890");
    expect(req).toMatchObject({ makingAmount: stored.sellAmountRaw, takingAmount: stored.minBuyRaw, expiredAt: asked.expiredAt });
    expect((await orders(pos._id)).every((d) => d.status === "ACTIVE" && d.orderRef === "pending:12345678901234567890")).toBe(true);
  });

  it("Kyber: an order whose id wasn't returned is found in the maker's listing, then fills are booked from its filled amounts", async () => {
    const { prepareArmEvm, activateEvm, syncAutoSells } = await import("@/services/autoSell");
    await isolate();
    const token = await makeToken("optimism", 0.0108);
    const pos = await makePosition(token);
    const a = await prepareArmEvm(userId, pos._id);
    await activateEvm(userId, pos._id, Object.fromEntries(a.orders.map((o) => [o.id, uniqueSig()])));
    const docs = await orders(pos._id);
    const first = docs[0];
    // Kyber's real listing shape: 2500 tokens sold, 0.009 WETH received, with the settlement transaction
    // pending orders are matched by ALL of their fields; every target here sells the same 2500 tokens, so the amount they
    // ask for (which differs by target price) is what tells them apart
    vi.mocked(kyber.kyberFindOrder).mockImplementation(async (_c, _m, ref) => {
      const idx = ref.req ? docs.findIndex((d) => d.minBuyRaw === ref.req!.takingAmount) : ref.id! - 4242;
      const id = 4242 + idx;
      const isFirst = idx === 0;
      return {
        id, status: isFirst ? "filled" : "open", makerAsset: token.address, takerAsset: "0x42", makingAmount: first.sellAmountRaw, takingAmount: first.minBuyRaw, expiredAt: 1,
        filledMakingAmount: isFirst ? first.sellAmountRaw : "0", filledTakingAmount: isFirst ? "9000000000000000" : "0",
        transactions: isFirst ? [{ txHash: "0x" + "ee".repeat(32) }] : [],
      };
    });
    const r = await syncAutoSells();
    expect(r.booked).toBeGreaterThanOrEqual(1);
    const after = (await (await collections.positions()).findOne({ _id: pos._id }))!;
    expect(after.amount).toBeCloseTo(7500, 3);
    expect(after.targetsHit).toBe(1);
    const sale = (await (await collections.trades()).find({ positionId: pos._id, side: "SELL" }).toArray())[0];
    expect(sale.transaction?.signature).toBe("0x" + "ee".repeat(32));
    expect(sale.inputUsd).toBeCloseTo(0.009 * 2704.72 || 0, -1); // WETH proceeds priced at the (mock) ETH price
    expect((await mine("PROFIT_TAKEN")).length).toBeGreaterThanOrEqual(1);
    // the pending reference was replaced by Kyber's real order id
    expect((await orders(pos._id)).some((d) => d.orderRef === "4242")).toBe(true);
  });

  it("Kyber: cancelling signs Kyber's cancel message with the real order ids, then marks the orders cancelled", async () => {
    const { prepareArmEvm, activateEvm, prepareCancelEvm, confirmCancelEvm } = await import("@/services/autoSell");
    await isolate();
    const token = await makeToken("optimism", 0.0108);
    const pos = await makePosition(token);
    const a = await prepareArmEvm(userId, pos._id);
    vi.mocked(kyber.submitKyberOrder).mockImplementation(async () => ({ id: Math.floor(Math.random() * 1e6) }));
    await activateEvm(userId, pos._id, Object.fromEntries(a.orders.map((o) => [o.id, uniqueSig()])));
    const c = await prepareCancelEvm(userId, pos._id);
    expect(c.chainId).toBe(10);
    const idsAsked = vi.mocked(kyber.kyberCancelSign).mock.calls[0][2];
    expect(idsAsked).toHaveLength(4);
    expect(idsAsked.every((n) => Number.isInteger(n))).toBe(true);
    expect((await confirmCancelEvm(userId, pos._id, SIG("c"))).cancelled).toBe(4);
    expect(vi.mocked(kyber.cancelKyberOrders)).toHaveBeenCalledWith("optimism", "0x" + "1".repeat(40), idsAsked, SIG("c"));
    expect((await orders(pos._id)).every((d) => d.status === "CANCELLED")).toBe(true);
    vi.mocked(kyber.submitKyberOrder).mockImplementation(async () => ({ id: null }));
  });

  it("Kyber rejecting an order's size is explained, not shown as a bare 'out of range'", async () => {
    const { prepareArmEvm, activateEvm } = await import("@/services/autoSell");
    await isolate();
    const pos = await makePosition(await makeToken("optimism", 0.01));
    const a = await prepareArmEvm(userId, pos._id);
    vi.mocked(kyber.submitKyberOrder).mockRejectedValue(new Error("Input is out of range: makingAmount (makingAmount)"));
    const r = await activateEvm(userId, pos._id, Object.fromEntries(a.orders.map((o) => [o.id, uniqueSig()])));
    expect(r.failed).toHaveLength(4);
    expect(r.failed[0].error).toMatch(/below its minimum, or the wallet does not hold or has not approved enough/);
    vi.mocked(kyber.submitKyberOrder).mockResolvedValue({ id: null });
  });

  it("a chain with no limit-order venue is refused politely", async () => {
    const { prepareArmEvm } = await import("@/services/autoSell");
    const pos = await makePosition(await makeToken("scroll", 0.01));
    await expect(prepareArmEvm(userId, pos._id)).rejects.toMatchObject({ status: 422 });
  });

  it("when a buy confirms, sell orders are suggested and the user is told (once)", async () => {
    const { reconcileLiveTrade } = await import("@/services/trading");
    const { providers } = await import("@/core/providers/registry");
    await (await collections.notifications()).deleteMany({ userId });
    const token = await makeToken("base", 0.01);
    vi.spyOn(providers().dex, "getTransactionStatus").mockResolvedValue({ status: "CONFIRMED", slot: 1 });
    const tradeId = newId();
    const now = new Date();
    await (await collections.trades()).insertOne({
      _id: tradeId, userId, accountId, tokenId: token._id, positionId: null, side: "BUY", kind: "AUTO_ENTRY", environment: "LIVE", dataSource: "MOCK", status: "PENDING",
      inputUsd: 100, tokenAmount: 10_000, priceUsd: 0.01, priceImpactPct: 0.3, slippageBps: 100, feesUsd: 0, networkFeeUsd: 0, realizedPnlUsd: null, quote: { signalId: null }, failureReason: null,
      expiresAt: null, createdAt: now, executedAt: null,
      transaction: { chain: "base", signature: "0x" + "9a".repeat(32), status: "PENDING", unsignedTx: "x", error: null, slot: null, submittedAt: now, confirmedAt: null, createdAt: now },
    } as never);
    await reconcileLiveTrade(tradeId);
    const positionId = (await (await collections.trades()).findOne({ _id: tradeId }))!.positionId!;
    created.positions.push(positionId);
    const docs = await orders(positionId);
    expect(docs.length).toBeGreaterThan(0);
    expect(docs.every((d) => d.status === "SUGGESTED" && d.venue === "cow")).toBe(true);
    const n = await mine("AUTOSELL_SUGGESTED");
    expect(n).toHaveLength(1);
    expect(n[0].body).toContain("Positions page");
    const { suggestAutoSells } = await import("@/services/autoSell");
    expect(await suggestAutoSells(positionId)).toBe(0); // already suggested: nothing new
    expect(await mine("AUTOSELL_SUGGESTED")).toHaveLength(1);
  });
});
