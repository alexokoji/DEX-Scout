/**
 * Balances and prices: the HyperEVM price bug (a USDC/WHYPE pool read as HYPE = $1), readable dollar balances, honest
 * "low balance" messages, live price fetching, and how a bought position's entry price and cost are recorded.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("next/headers", () => ({ cookies: async () => ({ get: () => undefined, set: () => {}, delete: () => {} }) }));
vi.mock("@/lib/env", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/env")>()), liveTradingAllowed: () => true }));

import { CHAINS } from "@/core/chains";
import { nativeUsdFromPairs, type DsNativePair } from "@/core/providers/evm/nativePrice";
import { allocate, checkManualAmount } from "@/core/trading/capital";
import { closeDb, collections, newId } from "@/lib/db";
import { nativeAmount, usdBalance } from "@/lib/format";
import type { TokenDoc } from "@/lib/models";
import { _clearLivePriceCache, livePrices, parseTokenKeys } from "@/services/livePrices";

const WHYPE = "0x5555555555555555555555555555555555555555";
// shapes copied from DexScreener for HyperEVM: the deepest pools are USDC/WHYPE (WHYPE is the QUOTE token)
const hyperPairs: DsNativePair[] = [
  { chainId: "hyperevm", baseToken: { address: "0xb88339CB7199b77E23DB6E890353E22632Ba630f" }, quoteToken: { address: WHYPE }, priceUsd: "0.9996", priceNative: "0.01067", liquidity: { usd: 15_192_890 } },
  { chainId: "hyperevm", baseToken: { address: "0xb88339CB7199b77E23DB6E890353E22632Ba630f" }, quoteToken: { address: WHYPE }, priceUsd: "1.00026", priceNative: "0.01068", liquidity: { usd: 9_307_213 } },
  { chainId: "hyperevm", baseToken: { address: "0xNEST" }, quoteToken: { address: WHYPE }, priceUsd: "0.01741", priceNative: "0.0001862", liquidity: { usd: 892_469 } },
];

describe("native price from DexScreener pairs", () => {
  it("HyperEVM: reads WHYPE's price through the quote side, not the USDC base price", () => {
    const px = nativeUsdFromPairs(hyperPairs, WHYPE, "hyperevm")!;
    expect(px).toBeGreaterThan(90); // ~ $93.7, NOT $0.9996
    expect(px).toBeLessThan(98);
  });
  it("uses priceUsd directly when the wrapped token is the base, and ignores other chains and dust pools", () => {
    const pairs: DsNativePair[] = [
      { chainId: "base", baseToken: { address: WHYPE }, quoteToken: { address: "0xusdc" }, priceUsd: "2700", priceNative: "1", liquidity: { usd: 5_000_000 } },
      { chainId: "ethereum", baseToken: { address: WHYPE }, quoteToken: { address: "0xusdc" }, priceUsd: "9999", priceNative: "1", liquidity: { usd: 9_000_000 } },
      { chainId: "base", baseToken: { address: WHYPE }, quoteToken: { address: "0xusdc" }, priceUsd: "1", priceNative: "1", liquidity: { usd: 100 } },
    ];
    expect(nativeUsdFromPairs(pairs, WHYPE, "base")).toBe(2700);
  });
  it("one oddly priced deep pool can't move it (median of the deepest pools), and no usable pairs means 'unknown', never a guess", () => {
    const mk = (usd: string, liq: number): DsNativePair => ({ chainId: "x", baseToken: { address: WHYPE }, quoteToken: { address: "0xq" }, priceUsd: usd, priceNative: "1", liquidity: { usd: liq } });
    expect(nativeUsdFromPairs([mk("40", 1e6), mk("41", 9e5), mk("39", 8e5), mk("4000", 1.2e6)], WHYPE, "x")).toBe(41);
    expect(nativeUsdFromPairs([], WHYPE, "x")).toBeNull();
    expect(nativeUsdFromPairs([mk("40", 10)], WHYPE, "x")).toBeNull();
  });
  it("every chain with its own coin has a wrapped-native address to price from, and ETH chains reuse Ethereum's price", () => {
    for (const c of Object.values(CHAINS)) {
      if (c.family === "evm" && !c.nativeUsdFrom) expect(c.wrappedNative).toMatch(/^0x[0-9a-fA-F]{40}$/);
      if (c.nativeUsdFrom) expect(CHAINS[c.nativeUsdFrom].nativeSymbol).toBe(c.nativeSymbol);
    }
  });
});

describe("balance formatting", () => {
  it("shows dollars with cents, '<$0.01' for dust, never a run of zeros", () => {
    expect(usdBalance(12.3456)).toBe("$12.35");
    expect(usdBalance(0.004)).toBe("<$0.01");
    expect(usdBalance(0)).toBe("$0.00");
    expect(usdBalance(null)).toBe("—");
  });
  it("shows coin amounts people can read", () => {
    expect(nativeAmount(12.3456789)).toBe("12.346");
    expect(nativeAmount(0.012345678)).toBe("0.0123");
    expect(nativeAmount(0.0000001)).toBe("<0.0001");
    expect(nativeAmount(15000.7)).toBe("15,001");
    expect(nativeAmount(0)).toBe("0");
  });
});

describe("low-balance messages say what is actually wrong", () => {
  const s = { maxPositionUsd: 1000, minPositionUsd: 1, maxOpenPositions: 5, maxDeployedUsd: null };
  it("a balance below the fee reserve is not reported as 'no balance'", () => {
    const r = allocate(s, { deployedUsd: 0, openPositions: 0, walletUsd: 0, walletBalanceUsd: 4.2, reserveUsd: 6 }, 10);
    expect(r).toMatchObject({ ok: false, reason: expect.stringContaining("Your wallet holds $4.20 on this chain") });
    expect((r as { reason: string }).reason).toContain("below the ~$6.00 a swap needs for fees");
    // and, when the reserve's make-up is known, it says what it is
    const withNote = allocate(s, { deployedUsd: 0, openPositions: 0, walletUsd: 0, walletBalanceUsd: 0.2, reserveUsd: 0.36, reserveNote: "network fee ~<$0.01, plus a one-time ~$0.18 deposit for the new token account" }, 10) as { reason: string };
    expect(withNote.reason).toContain("(network fee ~<$0.01, plus a one-time ~$0.18 deposit for the new token account)");
  });
  it("a truly empty wallet still says so", () => {
    expect(allocate(s, { deployedUsd: 0, openPositions: 0, walletUsd: 0, walletBalanceUsd: 0, reserveUsd: 6 }, 10)).toMatchObject({ ok: false, reason: expect.stringMatching(/holds none of this chain's coin/) });
  });
  it("a too-large manual buy shows the holding, the reserve and what is left", () => {
    expect(checkManualAmount(s, { deployedUsd: 0, openPositions: 0, walletUsd: 14, walletBalanceUsd: 20, reserveUsd: 6 }, 18)).toBe("Amount exceeds what you can spend on this chain: you hold $20.00, ~$6.00 is kept back for fees, leaving $14.00");
  });
});

describe("live price requests", () => {
  it("keeps only valid chain:address pairs, de-duplicates, lower-cases EVM addresses and caps the count", () => {
    const evm = "0x" + "AB".repeat(20);
    const sol = "So11111111111111111111111111111111111111112";
    const parsed = parseTokenKeys(`base:${evm},base:${evm},solana:${sol},nochain:${evm},base:short,garbage,solana:`);
    expect(parsed.map((p) => p.key)).toEqual([`base:${evm.toLowerCase()}`, `solana:${sol}`]);
    expect(parseTokenKeys(Array.from({ length: 80 }, (_, i) => `base:0x${i.toString(16).padStart(40, "0")}`).join(",")).length).toBe(30);
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

(dbUp ? describe : describe.skip)("fetching live prices and recording a purchase", () => {
  const userId = newId();
  const created: string[] = [];
  let template: TokenDoc;
  let accountId = "";

  async function makeToken(chain: string, priceUsd: number): Promise<TokenDoc> {
    const _id = newId();
    created.push(_id);
    const address = chain === "solana" ? `Sol${_id.replace(/-/g, "")}`.slice(0, 44) : `0x${_id.replace(/-/g, "")}00000000`.slice(0, 42);
    const t = { ...template, _id, chain, address, symbol: "LIVE", priceUsd, passedFilters: true, lastScannedAt: new Date(Date.now() - 3_600_000) } as TokenDoc;
    await (await collections.tokens()).insertOne(t);
    return t;
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
    await (await collections.users()).insertOne({ _id: userId, email: `pb-${Date.now()}@test.local`, passwordHash: "x", name: null, role: "USER", createdAt: now });
    accountId = newId();
    await (await collections.tradingAccounts()).insertOne({ _id: accountId, userId, environment: "LIVE", realizedPnlUsd: 0, createdAt: now });
    await (await collections.wallets()).insertOne({ _id: newId(), userId, chain: "evm", address: "0x" + "1".repeat(40), label: null, verifiedAt: now, createdAt: now });
  });
  afterEach(() => {
    vi.restoreAllMocks();
    _clearLivePriceCache();
  });
  afterAll(async () => {
    await Promise.all([
      (await collections.users()).deleteOne({ _id: userId }), (await collections.tradingAccounts()).deleteMany({ userId }), (await collections.wallets()).deleteMany({ userId }),
      (await collections.positions()).deleteMany({ userId }), (await collections.trades()).deleteMany({ userId }), (await collections.notifications()).deleteMany({ userId }),
      (await collections.autoSellOrders()).deleteMany({ userId }), (await collections.tokens()).deleteMany({ _id: { $in: created } }),
    ]).catch(() => {});
  });

  it("fetches straight from the market source for exactly the tokens asked for, shares it for a few seconds, and refreshes a stale stored price", async () => {
    const { providers } = await import("@/core/providers/registry");
    const token = await makeToken("base", 0.0055);
    const snap = { chain: "base", address: token.address, name: "L", symbol: "LIVE", decimals: 18, dex: "x", poolAddress: null, poolCreatedAt: new Date(), pairCount: 1, priceUsd: 0.007, marketCapUsd: 1e6, fdvUsd: 1e6, liquidityUsd: 500_000, liquidity1hAgoUsd: 500_000, volume5m: 1, volume15m: 1, volume30m: 1, volume1h: 1, volume24h: 1, buys5m: 1, sells5m: 1, buys15m: 1, sells15m: 1, buys1h: 1, sells1h: 1, change5m: 3, change1h: 1, change24h: 1, holders: 1, holders1hAgo: 1, observedAt: new Date(), dataSource: "LIVE" } as never;
    const refresh = vi.fn(async () => [snap]);
    const data = providers().data as unknown as { refresh?: unknown };
    data.refresh = refresh;
    try {
      const key = `base:${token.address}`;
      const r1 = await livePrices(key);
      expect(r1[key].priceUsd).toBe(0.007); // the market price, not the 0.0055 the database had
      expect(refresh).toHaveBeenCalledTimes(1);
      await livePrices(key); // within the sharing window: no second upstream request
      expect(refresh).toHaveBeenCalledTimes(1);
      await new Promise((r) => setTimeout(r, 150)); // the stale stored price is refreshed in the background
      expect((await (await collections.tokens()).findOne({ _id: token._id }))?.priceUsd).toBe(0.007);
      // a token the source doesn't return is simply left out
      _clearLivePriceCache();
      data.refresh = vi.fn(async () => []);
      expect(await livePrices(key)).toEqual({});
    } finally {
      delete data.refresh;
    }
  });

  it("a bought position records the price actually paid for the tokens, with fees in the cost but NOT the token-account deposit, and starts at the live market price", async () => {
    const { reconcileLiveTrade } = await import("@/services/trading");
    const { providers } = await import("@/core/providers/registry");
    const token = await makeToken("solana", 0.0055); // the stored price is an hour old...
    await (await collections.wallets()).insertOne({ _id: newId(), userId, chain: "solana", address: "W".repeat(44), label: null, verifiedAt: new Date(), createdAt: new Date(Date.now() + 1000) });
    const dex = providers().dex as unknown as { inspectTransaction?: unknown };
    vi.spyOn(providers().dex, "getTransactionStatus").mockResolvedValue({ status: "CONFIRMED", slot: 1 });
    // ...the market is at 0.006, and the SOL that left the wallet includes the ~0.00204 SOL token-account deposit
    vi.spyOn(providers().data, "getSnapshot").mockResolvedValue({ ...template, chain: "solana", address: token.address, priceUsd: 0.006, poolCreatedAt: new Date(), observedAt: new Date() } as never);
    dex.inspectTransaction = vi.fn(async () => ({ signer: "W".repeat(44), tokenDelta: 1000, nativeDelta: -(10 / 150 + 0.00204 + 0.0002) }));
    try {
      const tradeId = newId();
      const now = new Date();
      await (await collections.trades()).insertOne({
        _id: tradeId, userId, accountId, tokenId: token._id, positionId: null, side: "BUY", kind: "MANUAL_ENTRY", environment: "LIVE", dataSource: "LIVE", status: "PENDING",
        inputUsd: 10, tokenAmount: 1000, priceUsd: 0.01, priceImpactPct: 0.3, slippageBps: 300, feesUsd: 0, networkFeeUsd: 0.03, realizedPnlUsd: null, quote: { signalId: null }, failureReason: null,
        expiresAt: null, createdAt: now, executedAt: null,
        transaction: { chain: "solana", signature: "5" + "e".repeat(80), status: "PENDING", unsignedTx: "x", error: null, slot: null, submittedAt: now, confirmedAt: null, createdAt: now },
      } as never);
      expect(await reconcileLiveTrade(tradeId)).toMatchObject({ ok: true });
      const pos = (await (await collections.positions()).findOne({ _id: (await (await collections.trades()).findOne({ _id: tradeId }))!.positionId! }))!;
      created.push(); // positions are cleaned by userId
      expect(pos.entryPriceUsd).toBeCloseTo(10 / 1000, 10); // $10 swapped for 1000 tokens: $0.01 each, not inflated by the deposit
      expect(pos.investedUsd).toBeCloseTo(10.03, 6); // swap + the fee quoted
      expect(pos.costBasisUsd).toBeCloseTo(10.03, 6);
      expect(pos.entryMarketPriceUsd).toBe(0.006); // the market at the time, kept to compare with what was paid
      expect(pos.currentPriceUsd).toBe(0.006); // started at the live price, not the hour-old 0.0055
      expect(pos.priceAt).toBeInstanceOf(Date);
    } finally {
      delete dex.inspectTransaction;
    }
  });
});
