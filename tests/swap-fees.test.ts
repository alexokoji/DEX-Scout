/**
 * "There should be no hard-coded numbers at all: the chain should tell you if you have enough or not." Fees are read from the chain
 * when they are needed, and whether a wallet can afford a swap is asked of the chain (Solana's node simulates the exact
 * transaction; for EVM the node's own gas estimate for it is set against the wallet's balance). Nothing is estimated and padded.
 * The figures below are ones measured on the live chains and services while building this.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("next/headers", () => ({ cookies: async () => ({ get: () => undefined, set: () => {}, delete: () => {} }) }));
vi.mock("@/lib/env", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/env")>()), liveTradingAllowed: () => true }));

import { explainSolanaOnChainFailure } from "@/core/providers/solana/errors";
import { jupiterMinimumFromRefusal } from "@/core/providers/limitOrders/jupiter";
import { suggestSlippage } from "@/core/trading/slippage";
import { capMicroLamportsPerCu, LANDING_QUANTILE, percentile, priorityLamports, priorityMicroLamportsPerCu, readSolanaCosts, type FeeConnection } from "@/core/providers/solana/fees";
import { closeDb, collections, newId } from "@/lib/db";

const conn = (over: Partial<{ fees: number[]; base: number }> = {}): FeeConnection => ({
  getRecentPrioritizationFees: async () => (over.fees ?? Array(150).fill(0)).map((prioritizationFee) => ({ prioritizationFee })),
  baseFeePerSignature: async () => over.base ?? 5_000,
});

describe("the Solana priority fee is the market's price times the compute units Jupiter sizes for the swap", () => {
  it("the price is zero when nobody is paying any priority (as on the live chain network-wide: p50, p75, p90 and max all 0)", () => {
    expect(priorityMicroLamportsPerCu(Array(150).fill(0))).toBe(0);
    expect(priorityMicroLamportsPerCu([])).toBe(0);
  });
  it("follows the 90th percentile of the fees recently paid", () => {
    const fees = [...Array(100).fill(0), ...Array(50).fill(20_000)];
    expect(priorityMicroLamportsPerCu(fees)).toBe(percentile(fees, LANDING_QUANTILE));
    expect(priorityMicroLamportsPerCu(fees)).toBe(20_000);
  });
  it("becomes a fee by multiplying by the units the swap uses: no unit count is assumed anywhere", () => {
    // measured live on an active token's pools: p90 = 500,000 micro-lamports per unit; Jupiter sized a swap at 160,000 units
    expect(priorityLamports(500_000, 160_000)).toBe(80_000); // about $0.01
    expect(priorityLamports(500_000, 145_000)).toBe(72_500); // a different route, a different fee: from its own units
    expect(priorityLamports(0, 160_000)).toBe(0);
  });
  it("there is no built-in ceiling: a spike in the market is paid, and only the user's own cap limits it", () => {
    expect(priorityLamports(50_000_000, 160_000)).toBe(8_000_000); // 0.008 SOL: the market's price, uncapped
    expect(priorityLamports(50_000_000, 160_000, 10_000)).toBe(10_000);
    // the cap is held by lowering the price per unit, so the build (which prices the units it gets) can't exceed it either
    const micro = capMicroLamportsPerCu(50_000_000, 160_000, 10_000);
    expect(micro).toBeCloseTo(62_500, 6); // 10,000 lamports over 160,000 units
    expect(priorityLamports(micro, 160_000)).toBeLessThanOrEqual(10_000);
    expect(capMicroLamportsPerCu(500, 160_000)).toBe(500); // no cap, no change
  });
});

describe("readSolanaCosts", () => {
  it("reads the base fee and the priority price from the chain", async () => {
    expect(await readSolanaCosts(conn())).toEqual({ baseFeeLamports: 5_000, microLamportsPerCu: 0 });
    expect(await readSolanaCosts(conn({ base: 7_500, fees: Array(150).fill(10_000) }))).toEqual({ baseFeeLamports: 7_500, microLamportsPerCu: 10_000 });
  });
});

describe("Jupiter's own words decide its minimum order, and the swap is priced from its own compute units", () => {
  it("turns its refusal into the minimum in our measure of the order (measured live: 'at least 5 USD, received 4.84')", () => {
    // Jupiter measured our order at 4.84 and wants 5; we measured the same order at 4.84: so the minimum in our measure is 5
    expect(jupiterMinimumFromRefusal("Invalid create order request: Order size must be at least 5 USD, received: 4.84", 4.84)).toBeCloseTo(5, 10);
    // if its price feed reads the order a little lower than ours, the minimum is scaled the same way (our 4.9 was its 4.84)
    expect(jupiterMinimumFromRefusal("Order size must be at least 5 USD, received: 4.84", 4.9)).toBeCloseTo(5 * (4.9 / 4.84), 10);
    expect(jupiterMinimumFromRefusal("Order size must be at least 5 USD, received: 1.0999721993487010046", 1.1)).toBeCloseTo(5.0001, 3);
  });
  it("is not fooled by refusals that are about something else", () => {
    expect(jupiterMinimumFromRefusal("insufficient funds", 3)).toBeNull();
    expect(jupiterMinimumFromRefusal("Order size must be at least 5 USD, received: 0", 3)).toBeNull();
    expect(jupiterMinimumFromRefusal("", 3)).toBeNull();
  });

  afterEach(() => vi.unstubAllGlobals());
  it("a swap is built twice: once to learn the compute units Jupiter sizes for it, then priced at the market's rate for exactly those units", async () => {
    const { JupiterDexAdapter } = await import("@/core/providers/solana/solanaProviders");
    const bodies: Record<string, unknown>[] = [];
    vi.stubGlobal("fetch", async (_u: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "{}"));
      bodies.push(body);
      return new Response(JSON.stringify({ swapTransaction: bodies.length === 1 ? "first" : "second", computeUnitLimit: 160_000 }), { status: 200 });
    });
    const quote = { raw: { inputMint: "a", outputMint: "b" }, priorityMicroLamportsPerCu: 500_000 } as never;
    const r = await new JupiterDexAdapter().buildSwapTransaction(quote, "Wallet1111111111111111111111111111111111111");
    expect(bodies).toHaveLength(2);
    expect(bodies[0]).not.toHaveProperty("prioritizationFeeLamports"); // the first build is only to learn the units
    expect(bodies[1].prioritizationFeeLamports).toBe(80_000); // 500,000 micro-lamports x 160,000 units
    expect(r.unsignedTxBase64).toBe("second");
  });
  it("when nobody is paying priority, or the price isn't known, the swap is built once and no priority is invented", async () => {
    const { JupiterDexAdapter } = await import("@/core/providers/solana/solanaProviders");
    const bodies: Record<string, unknown>[] = [];
    vi.stubGlobal("fetch", async (_u: string, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body ?? "{}")));
      return new Response(JSON.stringify({ swapTransaction: "only", computeUnitLimit: 160_000 }), { status: 200 });
    });
    await new JupiterDexAdapter().buildSwapTransaction({ raw: {}, priorityMicroLamportsPerCu: 0 } as never, "W".repeat(44));
    expect(bodies).toHaveLength(1);
    bodies.length = 0;
    await new JupiterDexAdapter().buildSwapTransaction({ raw: {} } as never, "W".repeat(44));
    expect(bodies).toHaveLength(1);
    expect(bodies[0]).not.toHaveProperty("prioritizationFeeLamports");
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

describe("can an EVM wallet afford a swap? The chain's own gas estimate for the real transaction against the wallet's balance", () => {
  afterEach(() => vi.unstubAllGlobals());
  const USER = "0x" + "1".repeat(40);
  const buyTx = JSON.stringify({ chainId: 8453, tx: { to: "0x" + "2".repeat(40), data: "0xabcdef", value: "0x" + (BigInt(5) * BigInt("1000000000000000")).toString(16) } }); // swaps 0.005 ETH
  const sellTx = (swapGasUnits?: string) => JSON.stringify({ chainId: 8453, approval: { to: "0x" + "3".repeat(40), data: "0x095ea7b3", value: "0x0" }, tx: { to: "0x" + "2".repeat(40), data: "0xabcdef", value: "0x0" }, ...(swapGasUnits ? { swapGasUnits } : {}) });
  /** the "node": a balance, a gas price, and an estimate (or the error it gives) for whatever it is asked to estimate */
  const node = (o: { balanceWei: bigint; gasPriceWei?: bigint; estimate?: (p: { to: string }) => string | Error }) =>
    vi.stubGlobal("fetch", async (_u: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "{}"));
      const ok = (result: string) => new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result }), { status: 200 });
      if (body.method === "eth_getBalance") return ok("0x" + o.balanceWei.toString(16));
      if (body.method === "eth_gasPrice") return ok("0x" + (o.gasPriceWei ?? BigInt(1_000_000)).toString(16));
      if (body.method === "eth_estimateGas") {
        const r = (o.estimate ?? (() => "0x30d40"))(body.params[0]); // 200,000 gas
        return typeof r === "string" ? ok(r) : new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code: 3, message: r.message } }), { status: 200 });
      }
      return new Response("down", { status: 500 });
    });
  const ETH = (n: number) => BigInt(Math.round(n * 1e9)) * BigInt(1e9);

  it("a buy the wallet can cover: amount plus gas (200,000 gas at 1 gwei = 0.0002 ETH) is under the balance, so it goes through", async () => {
    const { preflightEvm } = await import("@/core/providers/evm/affordability");
    node({ balanceWei: ETH(0.01), gasPriceWei: BigInt(1e9) });
    expect(await preflightEvm("base", buyTx, USER)).toEqual({ ok: true });
  });
  it("a buy it can't: the answer names the real figures, from the chain, and where each part comes from", async () => {
    const { preflightEvm } = await import("@/core/providers/evm/affordability");
    node({ balanceWei: ETH(0.0051), gasPriceWei: BigInt(1e9) }); // covers the 0.005 swap but not the 0.0002 gas on top
    const r = await preflightEvm("base", buyTx, USER);
    expect(r).toMatchObject({ ok: false, kind: "insufficient_native" });
    expect((r as { error: string }).error).toBe("Not enough ETH: this needs 0.0052 ETH (0.005 ETH to swap + 0.0002 ETH network fee) and the wallet holds 0.0051 ETH.");
  });
  it("exactly enough is enough: there is no margin added on top of what the chain says", async () => {
    const { preflightEvm } = await import("@/core/providers/evm/affordability");
    node({ balanceWei: ETH(0.0052), gasPriceWei: BigInt(1e9) });
    expect(await preflightEvm("base", buyTx, USER)).toEqual({ ok: true });
  });
  it("when the node itself says the swap would revert, that is the answer, in its own words; slippage is recognised as such", async () => {
    const { preflightEvm } = await import("@/core/providers/evm/affordability");
    node({ balanceWei: ETH(1), estimate: () => new Error("execution reverted: Too little received") });
    expect(await preflightEvm("base", buyTx, USER)).toMatchObject({ ok: false, kind: "slippage" });
    node({ balanceWei: ETH(1), estimate: () => new Error("execution reverted: TRANSFER_FROM_FAILED") });
    const r = await preflightEvm("base", buyTx, USER);
    expect(r).toMatchObject({ ok: false, kind: "other" });
    expect((r as { error: string }).error).toContain("TRANSFER_FROM_FAILED");
    node({ balanceWei: ETH(1), estimate: () => new Error("insufficient funds for transfer") });
    expect(await preflightEvm("base", buyTx, USER)).toMatchObject({ ok: false, kind: "insufficient_native" });
  });
  it("what the balance alone proves is refused even when the node's gas estimate says something unrecognised (seen live: an empty wallet on Base)", async () => {
    const { preflightEvm } = await import("@/core/providers/evm/affordability");
    node({ balanceWei: BigInt(0), estimate: () => new Error("gas required exceeds allowance (0)") });
    const r = await preflightEvm("base", buyTx, USER);
    expect(r).toMatchObject({ ok: false, kind: "insufficient_native" });
    expect((r as { error: string }).error).toBe("Not enough ETH: this needs 0.005 ETH (0.005 ETH to swap) and the wallet holds 0 ETH.");
    // a sell has no amount to swap, but a wallet with nothing can't pay the approval's fee either
    node({ balanceWei: BigInt(0), estimate: () => new Error("gas required exceeds allowance (0)") });
    expect(await preflightEvm("base", sellTx(), USER)).toMatchObject({ ok: false, kind: "insufficient_native", error: expect.stringContaining("holds none") });
  });  it("a sell: the approval is estimated by the chain and the aggregator's own gas for the swap is added; the swap itself can't be estimated before the approval exists", async () => {
    const { preflightEvm } = await import("@/core/providers/evm/affordability");
    const asked: string[] = [];
    node({ balanceWei: ETH(0.0003), gasPriceWei: BigInt(1e9), estimate: (p) => (asked.push(p.to), "0xc350") }); // the approval: 50,000 gas
    expect(await preflightEvm("base", sellTx("150000"), USER)).toEqual({ ok: true }); // (50,000 + 150,000) x 1 gwei = 0.0002
    expect(asked).toEqual(["0x" + "3".repeat(40)]); // only the approval was estimated
    node({ balanceWei: ETH(0.00015), gasPriceWei: BigInt(1e9), estimate: () => "0xc350" });
    const r = await preflightEvm("base", sellTx("150000"), USER);
    expect(r).toMatchObject({ ok: false, kind: "insufficient_native" });
    expect((r as { error: string }).error).toContain("0.00005 ETH network fee for the approval + 0.00015 ETH network fee for the swap");
  });
  it("it never blocks on a node that didn't answer: unknown is left to the wallet, not treated as 'not enough'", async () => {
    const { preflightEvm } = await import("@/core/providers/evm/affordability");
    vi.stubGlobal("fetch", async () => new Response("down", { status: 500 }));
    expect(await preflightEvm("base", buyTx, USER)).toEqual({ ok: true });
    expect(await preflightEvm("base", "not json", USER)).toEqual({ ok: true });
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
    const fee = await evmTxFeeUsd("arbitrum", approval);
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

(dbUp ? describe : describe.skip)("a wallet's balance is the whole balance", () => {
  const userId = newId();
  const WALLET = "W".repeat(44);
  const OTHER = "V".repeat(44); // balances are cached briefly per address, so the unreadable-node test uses its own
  beforeAll(async () => {
    await (await collections.users()).insertOne({ _id: userId, email: `fees-${Date.now()}@test.local`, passwordHash: "x", name: null, role: "USER", createdAt: new Date() });
    await (await collections.wallets()).insertMany([
      { _id: newId(), userId, chain: "solana", address: WALLET, label: null, verifiedAt: new Date(), createdAt: new Date() },
      { _id: newId(), userId, chain: "solana", address: OTHER, label: null, verifiedAt: new Date(), createdAt: new Date() },
    ]);
  });
  afterEach(() => vi.restoreAllMocks());
  afterAll(async () => {
    await Promise.all([(await collections.users()).deleteOne({ _id: userId }), (await collections.wallets()).deleteMany({ userId })]).catch(() => {});
  });

  it("nothing is subtracted for fees: the chain answers whether a swap fits when it is prepared", async () => {
    const { providers } = await import("@/core/providers/registry");
    const { spendableDetail } = await import("@/services/walletBalance");
    vi.spyOn(providers().chains.solana, "getNativeBalance").mockResolvedValue(1); // 1 SOL
    vi.spyOn(providers().chains.solana, "nativeUsdPrice").mockResolvedValue(120);
    const r = await spendableDetail(userId, "solana", WALLET);
    expect(r).toEqual({ address: WALLET, balanceUsd: 120 });
  });
  it("no balance is reported when the node can't be read, never zero", async () => {
    const { providers } = await import("@/core/providers/registry");
    const { spendableDetail } = await import("@/services/walletBalance");
    vi.spyOn(providers().chains.solana, "getNativeBalance").mockRejectedValue(new Error("rpc down"));
    vi.spyOn(providers().chains.solana, "nativeUsdPrice").mockResolvedValue(120);
    expect(await spendableDetail(userId, "solana", OTHER)).toBeNull();
  });
});

describe("no hand-set fee, margin or limit is left in the live code", () => {
  it("the numbers that used to be here are gone from every live path", async () => {
    const fs = await import("node:fs");
    const live = ["src/core/providers/evm/evmProviders.ts", "src/core/providers/evm/freeAggregators.ts", "src/core/providers/evm/affordability.ts", "src/core/providers/solana/solanaProviders.ts", "src/core/providers/solana/fees.ts", "src/core/providers/limitOrders/jupiter.ts", "src/services/autoSell.ts", "src/services/walletBalance.ts"];
    const gone = /mockFeeUsd|typicalFeeUsd|SWAP_GAS_UNITS|GAS_PRICE_MARGIN|SWAP_COMPUTE_UNITS|MAX_AUTO_PRIORITY|JUP_FEE_FRACTION|JUP_MIN_ORDER_USD|estimateSwapReserve|swapReserveLamports|rentLamports|\?\? 5000|\bFEES\b/;
    for (const file of live) expect(fs.readFileSync(file, "utf8"), file).not.toMatch(gone);
  });
  it("the per-chain figures that remain are named for the mock market only", async () => {
    const { CHAINS, CHAIN_IDS } = await import("@/core/chains");
    expect(CHAIN_IDS.every((id) => "mockFeeUsd" in CHAINS[id] && !("typicalFeeUsd" in CHAINS[id]))).toBe(true);
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
