import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { rpcCandidates } from "@/core/chains";
import { evmRpc } from "@/core/providers/evm/evmProviders";
import { MultiEvmDexAdapter } from "@/core/providers/evm/freeAggregators";
import { markRpcBad, orderedRpcs, resetRpcHealth } from "@/core/providers/rpcHealth";
import { integrationViews } from "@/lib/integrations";

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

beforeEach(() => resetRpcHealth());
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("RPC endpoints need no key and fail over", () => {
  it("every chain has several free endpoints, and the operator's own URL (if set) is tried first", () => {
    for (const c of ["solana", "ethereum", "base", "bsc", "arbitrum", "polygon"] as const) expect(rpcCandidates(c).length).toBeGreaterThanOrEqual(2);
    vi.stubEnv("BASE_RPC_URL", "https://my-keyed-node.example/base");
    expect(rpcCandidates("base")[0]).toBe("https://my-keyed-node.example/base");
    vi.unstubAllEnvs();
  });

  it("moves past a dead endpoint to the next one and remembers the one that worked", async () => {
    const urls = rpcCandidates("ethereum");
    const calls: string[] = [];
    vi.stubGlobal("fetch", async (u: string) => {
      calls.push(u);
      return u === urls[0] ? new Response("down", { status: 503 }) : json({ jsonrpc: "2.0", id: 1, result: "0x1234" });
    });
    expect(await evmRpc<string>("ethereum", "eth_blockNumber", [])).toBe("0x1234");
    expect(calls).toEqual([urls[0], urls[1]]);
    // second call goes straight to the endpoint that worked; the dead one is cooling down
    calls.length = 0;
    await evmRpc<string>("ethereum", "eth_blockNumber", []);
    expect(calls).toEqual([urls[1]]);
    expect(orderedRpcs("ethereum")[0]).toBe(urls[1]);
  });

  it("treats a provider-side rejection (disabled key, rate limit) as a reason to fail over", async () => {
    const urls = rpcCandidates("polygon");
    vi.stubGlobal("fetch", async (u: string) => (u === urls[0] ? json({ jsonrpc: "2.0", id: 1, error: { message: "API key disabled" } }) : json({ jsonrpc: "2.0", id: 1, result: "0xabc" })));
    expect(await evmRpc<string>("polygon", "eth_call", [])).toBe("0xabc");
  });

  it("does NOT fail over on a genuine contract revert (every node would say the same)", async () => {
    const calls: string[] = [];
    vi.stubGlobal("fetch", async (u: string) => {
      calls.push(u);
      return json({ jsonrpc: "2.0", id: 1, error: { message: "execution reverted" } });
    });
    await expect(evmRpc("base", "eth_call", [])).rejects.toThrow(/reverted/);
    expect(calls).toHaveLength(1);
  });

  it("reports the last error when every endpoint is down, and skips cooling endpoints until all are cooling", async () => {
    vi.stubGlobal("fetch", async () => new Response("nope", { status: 500 }));
    await expect(evmRpc("bsc", "eth_blockNumber", [])).rejects.toThrow(/HTTP 500/);
    for (const u of rpcCandidates("bsc")) markRpcBad(u);
    expect(orderedRpcs("bsc")).toEqual(rpcCandidates("bsc")); // all cooling -> still tries them rather than giving up
  });
});

describe("EVM swaps work with no API key", () => {
  const TOKEN = "0x940181a94A35A4569E4529A3CDfB74e38FD98631";
  const DS_PAIR = {
    chainId: "base", dexId: "aerodrome", pairAddress: "0xpool", baseToken: { address: TOKEN, name: "Aero", symbol: "AERO" }, priceUsd: "0.80",
    txns: { m5: { buys: 5, sells: 4 }, h1: { buys: 100, sells: 90 } }, volume: { m5: 1000, h1: 20000, h24: 400000 }, priceChange: { m5: 0.1, h1: 1, h24: 2 },
    liquidity: { usd: 5_000_000 }, fdv: 9e8, marketCap: 8e8, pairCreatedAt: Date.now() - 400 * 86_400_000,
  };
  const routeFetch = (opts: { paraswap: "ok" | "fail" | "empty"; kyber: "ok" | "fail" }) =>
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const u = String(input);
      if (u.includes("/tokens/v1/")) return json([DS_PAIR]);
      if (u.includes("/latest/dex/tokens/")) return json({ pairs: [{ chainId: "ethereum", baseToken: { address: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2" }, quoteToken: { address: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48" }, priceUsd: "3000", priceNative: "1", liquidity: { usd: 9e7 } }] });
      if (u.includes("api.paraswap.io/prices")) {
        if (opts.paraswap === "fail") return new Response("err", { status: 500 });
        if (opts.paraswap === "empty") return json({ error: "No routes found" });
        // buying: $10 of ETH buys 10 tokens at $0.80 each. selling 12.5 tokens ($10) returns about 0.0033 ETH. A realistic fill either way: the adapter refuses quotes wildly off the market.
        const selling = u.includes(`srcToken=${TOKEN}`);
        return json({ priceRoute: { destAmount: selling ? "3300000000000000" : "10000000000000000000", gasCostUSD: "0.004", tokenTransferProxy: "0x6a000f20005980200259b80c5102003040001068", bestRoute: [{ swaps: [{ swapExchanges: [{ exchange: "AerodromeV3" }] }] }] } });
      }
      if (u.includes("api.paraswap.io/transactions")) return json({ to: "0x6a000f20005980200259b80c5102003040001068", data: "0xdeadbeef", value: "3000000000000000", chainId: 8453 });
      if (u.includes("kyberswap.com") && u.includes("/routes")) return opts.kyber === "fail" ? new Response("err", { status: 500 }) : json({ data: { routeSummary: { amountOut: u.includes(`tokenIn=${TOKEN}`) ? "3250000000000000" : "9900000000000000000", gasUsd: "0.01" }, routerAddress: "0x6131B5fae19EA4f9D964eAc0408E4408b66337b5" } });
      if (u.includes("kyberswap.com") && u.includes("/route/build")) return json({ data: { data: "0xcafebabe", routerAddress: "0x6131B5fae19EA4f9D964eAc0408E4408b66337b5", transactionValue: "3000000000000000", gas: "330000" } });
      if (init?.method === "POST" && u.includes("rpc")) return json({ jsonrpc: "2.0", id: 1, result: "0x" + (18).toString(16).padStart(64, "0") });
      if (init?.method === "POST") return json({ jsonrpc: "2.0", id: 1, result: "0x" + (18).toString(16).padStart(64, "0") }); // any RPC (decimals)
      return new Response("unexpected " + u, { status: 404 });
    });

  it("quotes through ParaSwap first with no key set, and builds an unsigned tx (no approval needed to buy)", async () => {
    vi.stubEnv("ZEROX_API_KEY", "");
    vi.stubGlobal("fetch", routeFetch({ paraswap: "ok", kyber: "ok" }));
    const dex = new MultiEvmDexAdapter();
    const q = await dex.getQuote({ chain: "base", side: "BUY", tokenAddress: TOKEN, amountUsd: 10, slippageBps: 300 });
    expect((q.raw as { aggregator: string }).aggregator).toBe("paraswap");
    expect(q.outputAmount).toBeCloseTo(10, 5);
    expect(q.route).toContain("AerodromeV3");
    const built = JSON.parse((await dex.buildSwapTransaction(q, "0x71C7656EC7ab88b098defB751B7401B5f6d8976F")).unsignedTxBase64);
    expect(built.tx.to).toBe("0x6a000f20005980200259b80c5102003040001068");
    expect(built.chainId).toBe(8453);
    expect(built.approval).toBeUndefined();
  });

  it("falls through to KyberSwap when ParaSwap is down or has no route — a failing aggregator never blocks the trade", async () => {
    vi.stubEnv("ZEROX_API_KEY", "");
    for (const paraswap of ["fail", "empty"] as const) {
      vi.stubGlobal("fetch", routeFetch({ paraswap, kyber: "ok" }));
      const dex = new MultiEvmDexAdapter();
      const q = await dex.getQuote({ chain: "base", side: "BUY", tokenAddress: TOKEN, amountUsd: 10, slippageBps: 300 });
      expect((q.raw as { aggregator: string }).aggregator).toBe("kyberswap");
      expect((JSON.parse((await dex.buildSwapTransaction(q, "0x71C7656EC7ab88b098defB751B7401B5f6d8976F")).unsignedTxBase64)).tx.data).toBe("0xcafebabe");
    }
  });

  it("a sell includes the ERC-20 approval to the aggregator's spender", async () => {
    vi.stubEnv("ZEROX_API_KEY", "");
    vi.stubGlobal("fetch", routeFetch({ paraswap: "ok", kyber: "ok" }));
    const dex = new MultiEvmDexAdapter();
    const q = await dex.getQuote({ chain: "base", side: "SELL", tokenAddress: TOKEN, amountUsd: 10, tokenAmount: 12.5, slippageBps: 300 });
    const built = JSON.parse((await dex.buildSwapTransaction(q, "0x71C7656EC7ab88b098defB751B7401B5f6d8976F")).unsignedTxBase64);
    expect(built.approval.to.toLowerCase()).toBe(TOKEN.toLowerCase());
    expect(built.approval.data.startsWith("0x095ea7b3")).toBe(true); // approve(address,uint256)
  });

  it("refuses a quote that is absurdly better than the market (the sign of a wrong native price, as on HyperEVM) instead of signing it", async () => {
    vi.stubEnv("ZEROX_API_KEY", "");
    const normal = routeFetch({ paraswap: "ok", kyber: "ok" });
    // both aggregators claim 94x more tokens than $10 can buy, which is what a $1 HYPE (really ~$94) produced
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const u = String(input);
      if (u.includes("api.paraswap.io/prices")) return json({ priceRoute: { destAmount: "940000000000000000000", gasCostUSD: "0.004", tokenTransferProxy: "0x6a000f20005980200259b80c5102003040001068", bestRoute: [] } });
      if (u.includes("kyberswap.com") && u.includes("/routes")) return json({ data: { routeSummary: { amountOut: "940000000000000000000", gasUsd: "0.01" }, routerAddress: "0x6131B5fae19EA4f9D964eAc0408E4408b66337b5" } });
      return normal(input, init);
    }));
    await expect(new MultiEvmDexAdapter().getQuote({ chain: "base", side: "BUY", tokenAddress: TOKEN, amountUsd: 10, slippageBps: 300 })).rejects.toThrow(/in the user's favour; refusing as it points to bad pricing data/);
  });

  it("reports every aggregator's reason when none can route, and never mentions a missing API key", async () => {
    vi.stubEnv("ZEROX_API_KEY", "");
    vi.stubGlobal("fetch", routeFetch({ paraswap: "fail", kyber: "fail" }));
    const err = await new MultiEvmDexAdapter().getQuote({ chain: "base", side: "BUY", tokenAddress: TOKEN, amountUsd: 10, slippageBps: 300 }).catch((e: Error) => e);
    expect((err as Error).message).toMatch(/paraswap/);
    expect((err as Error).message).toMatch(/kyberswap/);
    expect((err as Error).message).not.toMatch(/API_KEY|not configured/i);
  });
});

describe("integrations catalogue", () => {
  it("reports configured status without ever exposing a value", () => {
    vi.stubEnv("BIRDEYE_API_KEY", "super-secret-value");
    vi.stubEnv("MONGODB_URI", "");
    const views = integrationViews();
    const holders = views.find((v) => v.id === "holders")!;
    expect(holders.status).toBe("yours");
    expect(JSON.stringify(views)).not.toContain("super-secret-value");
    expect(views.find((v) => v.id === "database")!.status).toBe("missing"); // required + unset
    expect(views.find((v) => v.id === "evm-swaps")!.status).toBe("free"); // optional + unset -> free default
    vi.unstubAllEnvs();
  });

  it("nothing needed to trade is marked required except the operator's own database and secrets", () => {
    const required = integrationViews().filter((v) => v.kind === "required").map((v) => v.id).sort();
    expect(required).toEqual(["auth", "cron", "database"]);
  });
});
