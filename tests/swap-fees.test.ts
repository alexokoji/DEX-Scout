/**
 * "The network fees should come from the actual on-chain price, not set by you." Fees and the amount kept back are now
 * measured from the chain. These tests pin the maths with figures taken from the live chain (rent 1,488,440 lamports,
 * base fee 5,000, priority fees currently 0) and the plumbing around it.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("next/headers", () => ({ cookies: async () => ({ get: () => undefined, set: () => {}, delete: () => {} }) }));
vi.mock("@/lib/env", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/env")>()), liveTradingAllowed: () => true }));

import { explainSolanaOnChainFailure } from "@/core/providers/solana/errors";
import { suggestSlippage } from "@/core/trading/slippage";
import { LANDING_QUANTILE, MAX_AUTO_PRIORITY_LAMPORTS, percentile, priorityLamports, readSolanaCosts, SWAP_COMPUTE_UNITS, swapReserveLamports, TOKEN_ACCOUNT_BYTES, type FeeConnection } from "@/core/providers/solana/fees";
import { closeDb, collections, newId } from "@/lib/db";

// what the chain reported when this was written
const LIVE = { rent: 1_488_440, base: 5_000 };

const conn = (over: Partial<{ rent: number; fees: number[]; base: number; failFees: boolean }> = {}): FeeConnection => ({
  getMinimumBalanceForRentExemption: async (n) => {
    expect(n).toBe(TOKEN_ACCOUNT_BYTES); // asks the chain about a 165-byte token account
    return over.rent ?? LIVE.rent;
  },
  getRecentPrioritizationFees: async () => {
    if (over.failFees) throw new Error("rpc down");
    return (over.fees ?? Array(150).fill(0)).map((prioritizationFee) => ({ prioritizationFee }));
  },
  baseFeePerSignature: async () => over.base ?? LIVE.base,
});

describe("priority fee comes from what the network is charging", () => {
  it("is zero when the network isn't charging any priority (as it was on the live chain: p50, p75, p90 and max all 0)", () => {
    expect(priorityLamports(Array(150).fill(0))).toBe(0);
    expect(priorityLamports([])).toBe(0);
  });
  it("follows the 90th percentile of recent per-slot fees, converted to lamports for a swap's compute budget", () => {
    const fees = [...Array(100).fill(0), ...Array(50).fill(20_000)]; // a third of slots paid 20,000 micro-lamports/CU
    expect(percentile(fees, LANDING_QUANTILE)).toBe(20_000);
    expect(priorityLamports(fees)).toBe(Math.ceil((20_000 * SWAP_COMPUTE_UNITS) / 1_000_000)); // 4,000 lamports
    expect(priorityLamports(fees)).toBe(4_000);
  });
  it("bids high enough to land on a busy pool: with the figures measured live on an active token's pools (p90 = 500,000 micro-lamports/CU) it is ~100,000 lamports, about $0.01", () => {
    const pool = [...Array(60).fill(1_000), ...Array(60).fill(75_000), ...Array(30).fill(500_000)];
    expect(percentile(pool, 0.75)).toBe(75_000);
    expect(priorityLamports(pool)).toBe(100_000);
    // the network-wide list the old code used read all zeros: that bid would have landed behind everyone else
    expect(priorityLamports(Array(150).fill(0))).toBe(0);
  });
  it("a user-set cap limits it; an extreme spike is limited too", () => {
    const busy = Array(150).fill(50_000_000); // 50,000,000 micro-lamports/CU x 200k CU = 0.01 SOL for one swap: a spike worth limiting
    expect(priorityLamports(busy)).toBe(MAX_AUTO_PRIORITY_LAMPORTS);
    expect(priorityLamports(busy, 10_000)).toBe(10_000);
    expect(priorityLamports(Array(150).fill(20_000), 100)).toBe(100);
  });
});

describe("what a buy needs beyond its amount", () => {
  const costs = { baseFeeLamports: LIVE.base, priorityFeeLamports: 0, rentLamports: LIVE.rent };
  it("a wallet that already has the token account needs only fees and the temporary wrapped-SOL account", () => {
    const r = swapReserveLamports(costs, true);
    expect(r.needsTokenAccount).toBe(false);
    expect(r.peakLamports).toBe(5_000 + 1_488_440); // 0.00149 SOL
    expect(r.netLamports).toBe(5_000); // the temporary account is returned, so only the fee is really spent
  });
  it("a wallet without one also needs the deposit for it, and that deposit is what's left after the swap", () => {
    const r = swapReserveLamports(costs, false);
    expect(r.needsTokenAccount).toBe(true);
    expect(r.peakLamports).toBe(5_000 + 2 * 1_488_440); // 0.00298 SOL: about 36 cents at $120, not the $1.45 that was held back
    expect(r.netLamports).toBe(5_000 + 1_488_440);
  });
  it("not knowing whether the account exists assumes it doesn't (the safe side)", () => {
    expect(swapReserveLamports(costs, null).peakLamports).toBe(swapReserveLamports(costs, false).peakLamports);
  });
  it("the reserve follows the chain: if rent or fees change, so does it (nothing is baked in)", () => {
    const later = swapReserveLamports({ baseFeeLamports: 10_000, priorityFeeLamports: 6_000, rentLamports: 2_039_280 }, false);
    expect(later.peakLamports).toBe(10_000 + 6_000 + 2 * 2_039_280);
  });
});

describe("readSolanaCosts", () => {
  it("reads rent, base fee and priority fee from the chain", async () => {
    expect(await readSolanaCosts(conn())).toEqual({ baseFeeLamports: 5_000, priorityFeeLamports: 0, rentLamports: 1_488_440 });
    expect(await readSolanaCosts(conn({ rent: 2_039_280, base: 7_500, fees: Array(150).fill(10_000) }))).toEqual({ baseFeeLamports: 7_500, priorityFeeLamports: 2_000, rentLamports: 2_039_280 });
  });
  it("honours a user cap on the priority fee", async () => {
    expect((await readSolanaCosts(conn({ fees: Array(150).fill(10_000) }), 1_000)).priorityFeeLamports).toBe(1_000);
  });
});

describe("a swap that failed on-chain is explained, not shown as raw JSON", () => {
  it('slippage exceeded (the user-reported {"InstructionError":[6,{"Custom":6001}]}) says what happened and what it cost', async () => {
    const raw = '{"InstructionError":[6,{"Custom":6001}]}';
    const f = explainSolanaOnChainFailure(JSON.parse(raw));
    expect(f.kind).toBe("slippage");
    expect(f.message).toMatch(/slippage limit/);
    expect(f.message).toMatch(/Only the network fee was spent/);
    expect(f.message).not.toContain("InstructionError");
    const { humanOnChainFailure } = await import("@/services/trading");
    expect(humanOnChainFailure("solana", raw)).toBe(f.message); // the stored JSON string is parsed first
    expect(humanOnChainFailure("solana", "not json at all")).toMatch(/failed on-chain/);
    expect(humanOnChainFailure("bsc", "execution reverted: Too little received")).toMatch(/slippage/);
  });
  it("the notification doesn't end up with a doubled full stop", async () => {
    const { tradeFailed } = await import("@/services/notificationMessages");
    const m = tradeFailed("BUY", "WIF", "The swap was cancelled.", "t1");
    expect(m.body).toContain("The swap was cancelled. Nothing was bought");
    expect(m.body).not.toContain("..");
  });
});

describe("suggested slippage follows how fast the token is moving", () => {
  it("calm tokens get 3%, faster ones more, always within the user's own maximum", () => {
    expect(suggestSlippage(0.5, 2, 5000).bps).toBe(300);
    expect(suggestSlippage(5, 10, 5000).bps).toBe(500);
    expect(suggestSlippage(-12, 40, 5000).bps).toBe(1000); // down moves are as fast as up moves
    expect(suggestSlippage(35, 80, 5000).bps).toBe(2000);
    expect(suggestSlippage(1, 60, 5000).bps).toBe(1000); // a token that ran 60% in the hour counts as fast even if the last 5 minutes were quiet
  });
  it("is held to the user's maximum, and says so", () => {
    const s = suggestSlippage(35, 80, 500);
    expect(s).toMatchObject({ bps: 500, wantedBps: 2000, cappedByMax: true });
    expect(suggestSlippage(1, 1, 500).cappedByMax).toBe(false);
  });
  it("copes with missing numbers", () => {
    expect(suggestSlippage(NaN, NaN, 5000).bps).toBe(300);
  });
});

describe("what to keep back for gas on an EVM chain comes from the aggregators' own measurement of a real route", () => {
  afterEach(async () => {
    vi.unstubAllGlobals();
    (await import("@/core/providers/evm/swapGas")).resetSwapGasCache();
  });
  const WETH = "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2";
  const owner = "0x" + "1".repeat(40);
  let n = 0;
  const freshToken = () => "0x" + (++n).toString(16).padStart(40, "a");
  /** kyber / paraswap say what they say (null = not available); everything else the reserve needs is answered */
  const stub = (kyberUsd: string | null, paraswapUsd: string | null) =>
    vi.stubGlobal("fetch", async (u: string, init?: RequestInit) => {
      const url = String(u);
      if (init?.method === "POST") {
        const body = JSON.parse(String(init.body));
        if (body.method === "eth_call") return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: "0x" + "6".padStart(64, "0") }), { status: 200 }); // 6 decimals
        return new Response("down", { status: 500 });
      }
      if (url.includes("aggregator-api.kyberswap.com")) return kyberUsd ? new Response(JSON.stringify({ data: { routeSummary: { gasUsd: kyberUsd } } }), { status: 200 }) : new Response("no route", { status: 400 });
      if (url.includes("api.paraswap.io")) return paraswapUsd ? new Response(JSON.stringify({ priceRoute: { gasCostUSD: paraswapUsd } }), { status: 200 }) : new Response("no route", { status: 400 });
      if (url.includes(WETH)) return new Response(JSON.stringify({ pairs: [{ chainId: "ethereum", baseToken: { address: WETH }, quoteToken: { address: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48" }, priceUsd: "3000", priceNative: "1", liquidity: { usd: 5e8 } }] }), { status: 200 });
      return new Response("down", { status: 500 });
    });

  it("is what the aggregator says a swap into this token costs (units x the chain's gas price, as they measured it), converted to the native coin, plus headroom", async () => {
    const { EvmChainAdapter } = await import("@/core/providers/evm/evmProviders");
    stub("0.0116", null); // Kyber on Base measured $0.0116 for a real route; ETH is $3,000
    const r = await new EvmChainAdapter("base").estimateSwapReserve(owner, freshToken());
    expect(r!.feesNative).toBeCloseTo(0.0116 / 3000, 12);
    expect(r!.peakNative).toBeCloseTo((0.0116 / 3000) * 1.25, 12);
    expect(r!.depositNative).toBe(0);
  });
  it("follows the aggregator the swap would go through (ParaSwap first, then Kyber), since the two disagree a lot on the same swap ($0.0033 and $0.0116 on Base)", async () => {
    const { EvmChainAdapter } = await import("@/core/providers/evm/evmProviders");
    stub("0.0116", "0.0033");
    expect((await new EvmChainAdapter("base").estimateSwapReserve(owner, freshToken()))!.feesNative).toBeCloseTo(0.0033 / 3000, 12); // ParaSwap, as the quote will be
    stub("0.0116", null); // ParaSwap has no route: Kyber, as the quote will be
    expect((await new EvmChainAdapter("base").estimateSwapReserve(owner, freshToken()))!.feesNative).toBeCloseTo(0.0116 / 3000, 12);
  });
  it("is unknown (null), never a made-up number, when no aggregator can say, or no token is named", async () => {
    const { EvmChainAdapter } = await import("@/core/providers/evm/evmProviders");
    stub(null, null);
    expect(await new EvmChainAdapter("base").estimateSwapReserve(owner, freshToken())).toBeNull();
    stub("0.01", null);
    expect(await new EvmChainAdapter("base").estimateSwapReserve(owner)).toBeNull();
  });
  it("no fee figure is kept in the code for any chain's live path: the per-chain 'typical' fee exists only for the mock market", async () => {
    const { CHAINS, CHAIN_IDS } = await import("@/core/chains");
    expect(CHAIN_IDS.every((id) => "mockFeeUsd" in CHAINS[id] && !("typicalFeeUsd" in CHAINS[id]))).toBe(true);
    const fs = await import("node:fs");
    for (const file of ["src/core/providers/evm/evmProviders.ts", "src/core/providers/evm/freeAggregators.ts", "src/core/providers/solana/solanaProviders.ts"]) {
      const code = fs.readFileSync(file, "utf8");
      expect(code, file).not.toMatch(/mockFeeUsd|typicalFeeUsd|SWAP_GAS_UNITS|\?\? 5000/);
    }
  });
});
describe("what the one approval costs when arming auto-sell on an EVM chain", () => {
  afterEach(() => vi.unstubAllGlobals());
  const WETH = "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2";
  const stub = (gas: string | null) =>
    vi.stubGlobal("fetch", async (u: string, init?: RequestInit) => {
      if (init?.method === "POST") {
        const body = JSON.parse(String(init.body));
        if (body.method === "eth_gasPrice") return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: "0x59682f00" }), { status: 200 }); // 1.5 gwei
        if (body.method === "eth_estimateGas") return gas ? new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: gas }), { status: 200 }) : new Response("down", { status: 500 });
      }
      if (String(u).includes(WETH)) return new Response(JSON.stringify({ pairs: [{ chainId: "ethereum", baseToken: { address: WETH }, quoteToken: { address: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48" }, priceUsd: "3000", priceNative: "1", liquidity: { usd: 5e8 } }] }), { status: 200 });
      return new Response("down", { status: 500 });
    });
  const approval = { from: "0x" + "1".repeat(40), to: "0x" + "2".repeat(40), data: "0x095ea7b3" };

  it("is the chain's own gas estimate for that transaction x the gas price x the coin's price, in dollars", async () => {
    const { evmTxFeeUsd } = await import("@/core/providers/evm/evmProviders");
    stub("0xb71b"); // 46,875 gas: a typical ERC-20 approve
    const fee = await evmTxFeeUsd("base", approval);
    expect(fee).toBeCloseTo((1.5e9 * 46_875 * 3000) / 1e18, 6); // about $0.21 at 1.5 gwei and $3,000 ETH
  });
  it("is unknown (null), never a made-up number, when the gas estimate can't be had", async () => {
    const { evmTxFeeUsd } = await import("@/core/providers/evm/evmProviders");
    stub(null);
    expect(await evmTxFeeUsd("linea", approval)).toBeNull();
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

(dbUp ? describe : describe.skip)("the amount kept back from a wallet's balance", () => {
  const userId = newId();
  const WALLET = "W".repeat(44);

  beforeAll(async () => {
    await (await collections.users()).insertOne({ _id: userId, email: `fees-${Date.now()}@test.local`, passwordHash: "x", name: null, role: "USER", createdAt: new Date() });
    await (await collections.wallets()).insertOne({ _id: newId(), userId, chain: "solana", address: WALLET, label: null, verifiedAt: new Date(), createdAt: new Date() });
  });
  afterEach(() => vi.restoreAllMocks());
  afterAll(async () => {
    await Promise.all([(await collections.users()).deleteOne({ _id: userId }), (await collections.wallets()).deleteMany({ userId })]).catch(() => {});
  });

  async function setup(measured: { peakNative: number; feesNative: number; depositNative: number } | null) {
    const { providers } = await import("@/core/providers/registry");
    const c = providers().chains.solana as unknown as { estimateSwapReserve?: unknown };
    vi.spyOn(providers().chains.solana, "getNativeBalance").mockResolvedValue(1); // 1 SOL
    vi.spyOn(providers().chains.solana, "nativeUsdPrice").mockResolvedValue(120);
    const spy = vi.fn(async () => measured);
    c.estimateSwapReserve = spy;
    return spy;
  }
  afterEach(async () => {
    const { providers } = await import("@/core/providers/registry");
    delete (providers().chains.solana as unknown as { estimateSwapReserve?: unknown }).estimateSwapReserve;
  });

  it("holds back exactly what the chain says a swap needs for this wallet and token, and says what it is made of", async () => {
    const { spendableDetail } = await import("@/services/walletBalance");
    const spy = await setup({ peakNative: 0.002982, feesNative: 0.000005, depositNative: 0.00148844 });
    const r = await spendableDetail(userId, "solana", WALLET, "SomeMint1111111111111111111111111111111111");
    expect(spy).toHaveBeenCalledWith(WALLET, "SomeMint1111111111111111111111111111111111"); // asked about THIS wallet and token
    expect(r!.balanceUsd).toBeCloseTo(120, 6);
    expect(r!.reserveUsd).toBeCloseTo(0.002982 * 120, 6); // $0.36
    expect(r!.spendableUsd).toBeCloseTo(120 - 0.002982 * 120, 6);
    expect(r!.reserveNote).toContain("network fee ~<$0.01");
    expect(r!.reserveNote).toContain("one-time ~$0.18 deposit for the new token account that you get back");
  });

  it("when the chain's fees can't be read, nothing is held back and the note says so (unknown is not 'expensive')", async () => {
    const { spendableDetail } = await import("@/services/walletBalance");
    await setup(null);
    const r = await spendableDetail(userId, "solana", WALLET);
    expect(r!.reserveUsd).toBe(0);
    expect(r!.spendableUsd).toBeCloseTo(120, 6);
    expect(r!.reserveNote).toMatch(/couldn't be read/);
  });

  it("a wallet that already holds the token isn't charged the deposit in the note", async () => {
    const { describeReserve } = await import("@/services/walletBalance");
    expect(describeReserve({ peakNative: 0.0015, feesNative: 0.000005, depositNative: 0 }, 120)).toBe("network fee ~<$0.01");
  });
});

describe("SOL and native prices are never guessed", () => {
  afterEach(() => vi.unstubAllGlobals());
  it("solUsd reads SOL's price through the QUOTE side of a pool (like the HyperEVM bug) and refuses to guess when nothing is available", async () => {
    vi.resetModules();
    const { solUsd } = await import("@/core/providers/solana/solanaProviders");
    const WSOL = "So11111111111111111111111111111111111111112";
    vi.stubGlobal("fetch", async () => new Response("down", { status: 500 }));
    await expect(solUsd()).rejects.toThrow(/No live SOL price/);
    // the deepest pool lists USDC as the BASE token, so priceUsd (0.9998) is USDC's; SOL's price is priceUsd / priceNative
    vi.stubGlobal("fetch", async () => new Response(JSON.stringify({ pairs: [{ chainId: "solana", baseToken: { address: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v" }, quoteToken: { address: WSOL }, priceUsd: "0.9998", priceNative: "0.00828", liquidity: { usd: 9e7 } }] }), { status: 200 }));
    expect(await solUsd()).toBeGreaterThan(115);
    expect(await solUsd()).toBeLessThan(125);
  });
});
