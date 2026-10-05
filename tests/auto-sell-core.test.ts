/** Auto-sell: the planning maths, the venue payloads, and parsing of the real responses captured from CoW and Jupiter. */
import { describe, expect, it } from "vitest";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { decodeFunctionData, erc20Abi, hashTypedData, verifyTypedData } from "viem";
import { autoSellVenue, CHAIN_IDS, CHAINS } from "@/core/chains";
import { buildCowOrder, COW_RELAYER, COW_SETTLEMENT, cowApprovalTx, cowCancelTypedData, cowTypedData } from "@/core/providers/limitOrders/cow";
import { jupiterFills, type JupOrder } from "@/core/providers/limitOrders/jupiter";
import { fillDelta, mergeForMinimum, minProceedsRaw, planAutoSells, toRaw } from "@/core/trading/autoSell";
import { profitPct, profitTaken } from "@/services/notificationMessages";

const DEFAULT_TARGETS = [
  { level: 1, gainPct: 8, sellPct: 25 },
  { level: 2, gainPct: 15, sellPct: 25 },
  { level: 3, gainPct: 25, sellPct: 25 },
  { level: 4, gainPct: 40, sellPct: 100 },
];
const pos = (over = {}) => ({ entryPriceUsd: 0.01, initialAmount: 10_000, amount: 10_000, costBasisUsd: 100, targetsHit: 0, ...over });

describe("planAutoSells", () => {
  it("makes one order per target with exactly the amounts the manual target logic sells", () => {
    const p = planAutoSells(pos(), DEFAULT_TARGETS);
    expect(p.map((o) => o.levels)).toEqual([[1], [2], [3], [4]]);
    expect(p.map((o) => o.tokenAmount)).toEqual([2500, 2500, 2500, 2500]); // the last takes whatever remains
    expect(p.map((o) => o.gainPct)).toEqual([8, 15, 25, 40]);
    expect(p[0].targetPriceUsd).toBeCloseTo(0.0108, 10);
    expect(p.reduce((s, o) => s + o.tokenAmount, 0)).toBe(10_000);
  });

  it("only plans the targets not yet hit, from what is left", () => {
    const p = planAutoSells(pos({ amount: 5_000, targetsHit: 2, costBasisUsd: 50 }), DEFAULT_TARGETS);
    expect(p.map((o) => o.levels)).toEqual([[3], [4]]);
    expect(p.reduce((s, o) => s + o.tokenAmount, 0)).toBe(5_000);
  });

  it("a single 100% target is one order, and a closed or empty position has none", () => {
    expect(planAutoSells(pos(), [{ level: 1, gainPct: 10, sellPct: 100 }])).toHaveLength(1);
    expect(planAutoSells(pos({ amount: 0 }), DEFAULT_TARGETS)).toEqual([]);
    expect(planAutoSells(pos({ entryPriceUsd: 0 }), DEFAULT_TARGETS)).toEqual([]);
    expect(planAutoSells(pos({ targetsHit: 4 }), DEFAULT_TARGETS)).toEqual([]);
  });
});

describe("mergeForMinimum (venues with a minimum order size)", () => {
  const plan = () => planAutoSells(pos(), DEFAULT_TARGETS); // 4 x 2500 tokens
  it("leaves orders alone when each is big enough", () => {
    expect(mergeForMinimum(plan(), 0.01, 5.5)).toHaveLength(4); // 2500 * 0.01 = $25 each
  });
  it("merges slices that are too small forward, selling them at the EARLIER target, and never loses tokens", () => {
    const m = mergeForMinimum(plan(), 0.0025, 5.5); // $6.25 each is fine...
    expect(m).toHaveLength(4);
    const small = mergeForMinimum(plan(), 0.0015, 5.5); // $3.75 each: pairs are needed
    expect(small.map((o) => o.levels)).toEqual([[1, 2], [3, 4]]);
    expect(small[0].gainPct).toBe(8); // earlier target's price
    expect(small[0].targetPriceUsd).toBeCloseTo(0.0108, 10);
    expect(small.reduce((s, o) => s + o.tokenAmount, 0)).toBe(10_000);
  });
  it("a too-small tail joins the previous order; a position below the minimum entirely gets no order", () => {
    const tail = mergeForMinimum([{ levels: [1], gainPct: 8, targetPriceUsd: 1, tokenAmount: 100 }, { levels: [2], gainPct: 15, targetPriceUsd: 1.1, tokenAmount: 1 }], 0.1, 5.5);
    expect(tail).toEqual([{ levels: [1, 2], gainPct: 8, targetPriceUsd: 1, tokenAmount: 101 }]);
    expect(mergeForMinimum(plan(), 0.0001, 5.5)).toEqual([]);
  });
});

describe("amounts", () => {
  it("toRaw is exact for large decimals and rejects junk", () => {
    expect(toRaw(1.5, 18)).toBe(BigInt("1500000000000000000"));
    expect(toRaw(0.000001, 6)).toBe(BigInt(1));
    expect(toRaw(2500, 9)).toBe(BigInt("2500000000000"));
    expect(toRaw(0, 18)).toBe(BigInt(0));
    expect(toRaw(NaN, 18)).toBe(BigInt(0));
    expect(toRaw(-3, 18)).toBe(BigInt(0));
  });
  it("minProceedsRaw is the tokens at the target price in native units, grossed up for a venue fee", () => {
    // 2500 tokens at $0.0108 = $27 of ETH at $3000 = 0.009 ETH
    expect(minProceedsRaw(2500, 0.0108, 3000, 18)).toBe(BigInt("9000000000000000"));
    // 1% venue fee: ask for 0.009 / 0.99 so the user nets the target
    const gross = minProceedsRaw(2500, 0.0108, 3000, 18, 0.01);
    expect(Number(gross) / 1e18).toBeCloseTo(0.009 / 0.99, 9);
    expect(minProceedsRaw(2500, 0.0108, 0, 18)).toBe(BigInt(0)); // unknown native price: no order rather than a nonsense one
  });
  it("fillDelta only returns what has not been booked yet", () => {
    const z = BigInt(0);
    expect(fillDelta({ sellRaw: z, buyRaw: z }, { sellRaw: z, buyRaw: z })).toBeNull();
    expect(fillDelta({ sellRaw: BigInt(100), buyRaw: BigInt(5) }, { sellRaw: BigInt(100), buyRaw: BigInt(5) })).toBeNull();
    expect(fillDelta({ sellRaw: BigInt(100), buyRaw: BigInt(5) }, { sellRaw: BigInt(250), buyRaw: BigInt(12) })).toEqual({ sellRaw: BigInt(150), buyRaw: BigInt(7) });
  });
});

describe("venue coverage", () => {
  it("auto-sell covers Solana (Jupiter), eight chains on CoW, seven more on Kyber, and only these five are left without a venue", () => {
    expect(autoSellVenue("solana")).toBe("jupiter");
    const cow = CHAIN_IDS.filter((c) => autoSellVenue(c) === "cow");
    expect([...cow].sort()).toEqual(["arbitrum", "avalanche", "base", "bsc", "ethereum", "ink", "linea", "polygon"]);
    const kyber = CHAIN_IDS.filter((c) => autoSellVenue(c) === "kyber");
    expect([...kyber].sort()).toEqual(["berachain", "hyperevm", "monad", "optimism", "robinhood", "sonic", "unichain"]);
    const none = CHAIN_IDS.filter((c) => autoSellVenue(c) === null);
    expect([...none].sort()).toEqual(["abstract", "blast", "mantle", "scroll", "world"]);
    for (const c of cow) expect(CHAINS[c].cowNetwork).toBeTruthy();
    for (const c of [...cow, ...kyber]) expect(CHAINS[c].family).toBe("evm");
    for (const c of kyber) expect(CHAINS[c].kyberLimitOrders).toBe(true);
    // the wrapped coin Kyber pays out in must exist for every Kyber chain
    for (const c of kyber) expect(CHAINS[c].wrappedNative).toMatch(/^0x[0-9a-fA-F]{40}$/);
  });
});

describe("CoW order payloads", () => {
  const owner = privateKeyToAccount(generatePrivateKey());
  const token = "0x" + "ab".repeat(20);
  const order = () => buildCowOrder({ owner: owner.address, sellToken: token, sellAmountRaw: BigInt("2500000000000000000000"), minBuyRaw: BigInt("9000000000000000"), validTo: 1_900_000_000 });

  it("sells the token for the chain's native currency, to the owner, fill-or-nothing", () => {
    expect(order()).toMatchObject({ buyToken: "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE", receiver: owner.address, kind: "sell", partiallyFillable: false, feeAmount: "0", sellAmount: "2500000000000000000000", buyAmount: "9000000000000000" });
  });

  it("the typed data a wallet signs verifies for the owner against the settlement contract, and is chain-bound", async () => {
    const t = cowTypedData(8453, order());
    expect(t.domain).toEqual({ name: "Gnosis Protocol", version: "v2", chainId: 8453, verifyingContract: COW_SETTLEMENT });
    const { EIP712Domain: _d, ...types } = t.types;
    void _d;
    const sig = await owner.signTypedData({ domain: t.domain, types, primaryType: "Order", message: { ...t.message, sellAmount: BigInt(t.message.sellAmount), buyAmount: BigInt(t.message.buyAmount), feeAmount: BigInt(0) } as never });
    const ok = await verifyTypedData({ address: owner.address, domain: t.domain, types, primaryType: "Order", message: { ...t.message, sellAmount: BigInt(t.message.sellAmount), buyAmount: BigInt(t.message.buyAmount), feeAmount: BigInt(0) } as never, signature: sig });
    expect(ok).toBe(true);
    // a signature for Base must not be valid on Ethereum
    expect(hashTypedData({ domain: cowTypedData(1, order()).domain, types, primaryType: "Order", message: { ...t.message, sellAmount: BigInt(t.message.sellAmount), buyAmount: BigInt(t.message.buyAmount), feeAmount: BigInt(0) } as never })).not.toBe(
      hashTypedData({ domain: t.domain, types, primaryType: "Order", message: { ...t.message, sellAmount: BigInt(t.message.sellAmount), buyAmount: BigInt(t.message.buyAmount), feeAmount: BigInt(0) } as never }),
    );
  });

  it("the approval is for the exact amount to CoW's relayer, never unlimited", () => {
    const tx = cowApprovalTx(token, BigInt(12345));
    const d = decodeFunctionData({ abi: erc20Abi, data: tx.data as `0x${string}` });
    expect(d.functionName).toBe("approve");
    expect((d.args?.[0] as string).toLowerCase()).toBe(COW_RELAYER.toLowerCase());
    expect(d.args?.[1]).toBe(BigInt(12345));
    expect(tx.to.toLowerCase()).toBe(token);
  });

  it("the cancellation typed data lists the uids", () => {
    const t = cowCancelTypedData(8453, ["0x" + "11".repeat(56)]);
    expect(t.primaryType).toBe("OrderCancellations");
    expect(t.message.orderUids).toEqual(["0x" + "11".repeat(56)]);
  });
});

describe("Jupiter fills, parsed from real order histories", () => {
  // shapes copied from live getTriggerOrders responses
  const completed: JupOrder = {
    orderKey: "CdN8", status: "Completed", rawMakingAmount: "100000000000000", rawRemainingMakingAmount: "0", closeTx: "5Yb",
    trades: [{ action: "Fill", rawInputAmount: "100000000000000", rawOutputAmount: "1360000000", rawFeeAmount: "11016000", feeMint: "So11111111111111111111111111111111111111112", outputMint: "So11111111111111111111111111111111111111112", txId: "5YbhAV" }],
  };
  const twoFills: JupOrder = {
    orderKey: "x", status: "Completed", rawMakingAmount: "100000000000000", rawRemainingMakingAmount: "0",
    trades: [
      { action: "Fill", rawInputAmount: "80000000000000", rawOutputAmount: "1127200000", rawFeeAmount: "9130320", feeMint: "So11111111111111111111111111111111111111112", outputMint: "So11111111111111111111111111111111111111112", txId: "tx1" },
      { action: "Fill", rawInputAmount: "20000000000000", rawOutputAmount: "280000000", rawFeeAmount: "2268000", feeMint: "So11111111111111111111111111111111111111112", outputMint: "So11111111111111111111111111111111111111112", txId: "tx2" },
    ],
  };
  it("a completed order: tokens sold and SOL received after Jupiter's fee", () => {
    const f = jupiterFills(completed);
    expect(f.sellRaw).toBe(BigInt("100000000000000"));
    expect(f.buyRaw).toBe(BigInt(1_360_000_000 - 11_016_000));
    expect(f.txIds).toEqual(["5YbhAV"]);
  });
  it("several fills add up, and an order with no fills, or a cancelled one, books nothing", () => {
    const f = jupiterFills(twoFills);
    expect(f.sellRaw).toBe(BigInt("100000000000000"));
    expect(f.txIds).toEqual(["tx1", "tx2"]);
    expect(jupiterFills({ orderKey: "o", status: "Open", trades: [] })).toEqual({ sellRaw: BigInt(0), buyRaw: BigInt(0), txIds: [] });
    expect(jupiterFills({ orderKey: "o", status: "Cancelled" }).sellRaw).toBe(BigInt(0));
    expect(jupiterFills({ orderKey: "o", status: "Open", trades: [{ action: "Cancel", rawInputAmount: "5" }] }).sellRaw).toBe(BigInt(0));
  });
});

describe("profit notification wording", () => {
  it("profitPct is profit over the cost of the part sold", () => {
    expect(profitPct(108, 8)).toBeCloseTo(8, 6); // sold for 108 what cost 100
    expect(profitPct(90, -10)).toBeCloseTo(-10, 6);
    expect(profitPct(0, 0)).toBe(0);
  });
  it("says the percent and dollars made, and the overall result when the position closes", () => {
    const m = profitTaken({ symbol: "PEPE", chainName: "Base", tokens: 2500, proceedsUsd: 27, realizedDeltaUsd: 2, closed: false, tradeId: "t", auto: true });
    expect(m.title).toBe("Profit taken: PEPE +8.0%");
    expect(m.body).toContain("Your auto-sell order filled.");
    expect(m.body).toContain("profit +$2.00 (+8.0% on that portion)");
    expect(m.body).toContain("rest stays open");
    const closed = profitTaken({ symbol: "PEPE", chainName: "Base", tokens: 2500, proceedsUsd: 40, realizedDeltaUsd: 15, closed: true, tradeId: "t", totalPnlUsd: 31, totalPnlPct: 31 });
    expect(closed.title).toBe("Profit taken: PEPE +60.0%");
    expect(closed.body).toContain("Position closed: +31.0% overall (+$31.00)");
    const loss = profitTaken({ symbol: "X", chainName: "Base", tokens: 1, proceedsUsd: 9, realizedDeltaUsd: -1, closed: true, tradeId: "t" });
    expect(loss.title).toBe("Sold X at a loss: -10.0%");
  });
});
