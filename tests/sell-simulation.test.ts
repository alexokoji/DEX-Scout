/**
 * "I keep getting sell simulation failed when I try to buy a token". Two causes: (1) a regression where the EVM sanity check
 * misread every sell dry-run (no token amount => price per token computed as proceeds / 1) and refused it, so nearly every
 * EVM token failed; (2) a busy price service or a data hiccup being treated as "honeypot". Plus the flow heuristic blocking
 * established deep pools.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("next/headers", () => ({ cookies: async () => ({ get: () => undefined, set: () => {}, delete: () => {} }) }));
vi.mock("@/lib/env", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/env")>()), liveTradingAllowed: () => true }));

import { looksLikeHoneypotFlow } from "@/core/analysis/honeypot";
import { MultiEvmDexAdapter } from "@/core/providers/evm/freeAggregators";
import { sellCheckInconclusive } from "@/core/providers/simFailure";
import { closeDb, collections, newId } from "@/lib/db";
import type { TokenDoc } from "@/lib/models";

describe("sellCheckInconclusive", () => {
  it("is conclusive only when every reason is a real 'no route'", () => {
    expect(sellCheckInconclusive("No swap route found on any aggregator (paraswap: HTTP 400 from api.paraswap.io; kyberswap: HTTP 404 from aggregator-api.kyberswap.com)")).toBe(false);
    expect(sellCheckInconclusive("No route / zero output")).toBe(false);
    expect(sellCheckInconclusive("HTTP 400 from lite-api.jup.ag")).toBe(false); // Jupiter: could not find any route
  });
  it("is inconclusive for rate limits, timeouts, server errors, data misses and refused-bad-data quotes", () => {
    for (const m of [
      "No swap route found on any aggregator (paraswap: HTTP 429 from api.paraswap.io; kyberswap: HTTP 429 from aggregator-api.kyberswap.com)",
      "No swap route found on any aggregator (paraswap: HTTP 500 from api.paraswap.io; kyberswap: The operation was aborted due to timeout)",
      "HTTP 429 from lite-api.jup.ag",
      "fetch failed",
      "Token not found or no longer tradeable",
      "No swap route found on any aggregator (paraswap: quote is 1080% away from the market price in the user's favour; refusing as it points to bad pricing data)",
    ]) expect(sellCheckInconclusive(m), m).toBe(true);
  });
  it("one aggregator saying 'no route' while another failed to answer is not proof either way", () => {
    expect(sellCheckInconclusive("No swap route found on any aggregator (paraswap: HTTP 400 from api.paraswap.io; kyberswap: HTTP 503 from aggregator-api.kyberswap.com)")).toBe(true);
  });
});

describe("looksLikeHoneypotFlow", () => {
  const now = Date.parse("2026-10-06T12:00:00Z");
  const hoursAgo = (h: number) => new Date(now - h * 3_600_000);
  const s = (o: Partial<{ buys1h: number; sells1h: number; liquidityUsd: number; poolCreatedAt: Date }> = {}) => ({ buys1h: 40, sells1h: 0, liquidityUsd: 30_000, poolCreatedAt: hoursAgo(2), ...o });
  it("flags buyers who can't get out: many buys, no sells, on a young or shallow pool", () => {
    expect(looksLikeHoneypotFlow(s(), now)).toBe(true);
    expect(looksLikeHoneypotFlow(s({ liquidityUsd: 400_000, poolCreatedAt: hoursAgo(2) }), now)).toBe(true); // deep but brand new
    expect(looksLikeHoneypotFlow(s({ liquidityUsd: 20_000, poolCreatedAt: hoursAgo(500) }), now)).toBe(true); // old but shallow
  });
  it("does not flag an established deep pool just because one hour was one-sided (a stablecoin, a quiet blue chip)", () => {
    expect(looksLikeHoneypotFlow(s({ buys1h: 27, liquidityUsd: 636_339, poolCreatedAt: hoursAgo(24 * 200) }), now)).toBe(false);
  });
  it("never flags when there are sells, or too few buys to say anything", () => {
    expect(looksLikeHoneypotFlow(s({ sells1h: 1 }), now)).toBe(false);
    expect(looksLikeHoneypotFlow(s({ buys1h: 19 }), now)).toBe(false);
  });
});

describe("EVM sell dry-run (the regression)", () => {
  const TOKEN = "0x940181a94A35A4569E4529A3CDfB74e38FD98631";
  const json = (b: unknown) => new Response(JSON.stringify(b), { status: 200, headers: { "content-type": "application/json" } });
  const DS_PAIR = {
    chainId: "base", dexId: "aerodrome", pairAddress: "0xpool", baseToken: { address: TOKEN, name: "Aero", symbol: "AERO" }, priceUsd: "0.80",
    txns: { m5: { buys: 5, sells: 4 }, h1: { buys: 100, sells: 90 } }, volume: { m5: 1000, h1: 20000, h24: 400000 }, priceChange: { m5: 0.1, h1: 1, h24: 2 },
    liquidity: { usd: 5_000_000 }, fdv: 9e8, marketCap: 8e8, pairCreatedAt: Date.now() - 400 * 86_400_000,
  };
  /** realistic fills: selling $10 of a $0.80 token (12.5 tokens) returns ~0.0033 ETH at $3000 */
  const stub = (paraswap: "ok" | number, kyber: "ok" | number) =>
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const u = String(input);
      if (u.includes("/tokens/v1/")) return json([DS_PAIR]);
      if (u.includes("/latest/dex/tokens/")) return json({ pairs: [{ chainId: "ethereum", baseToken: { address: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2" }, quoteToken: { address: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48" }, priceUsd: "3000", priceNative: "1", liquidity: { usd: 9e7 } }] });
      if (u.includes("api.paraswap.io/prices")) return paraswap === "ok" ? json({ priceRoute: { destAmount: "3300000000000000", gasCostUSD: "0.004", tokenTransferProxy: "0x6a000f20005980200259b80c5102003040001068", bestRoute: [] } }) : new Response("x", { status: paraswap });
      if (u.includes("kyberswap.com") && u.includes("/routes")) return kyber === "ok" ? json({ data: { routeSummary: { amountOut: "3250000000000000", gasUsd: "0.01" }, routerAddress: "0x6131B5fae19EA4f9D964eAc0408E4408b66337b5" } }) : new Response("x", { status: kyber });
      if (init?.method === "POST") return json({ jsonrpc: "2.0", id: 1, result: "0x" + (18).toString(16).padStart(64, "0") });
      return new Response("unexpected " + u, { status: 404 });
    });
  const sell = { chain: "base" as const, side: "SELL" as const, tokenAddress: TOKEN, amountUsd: 10, slippageBps: 300 }; // note: no tokenAmount, like the pre-buy check

  afterEach(() => vi.unstubAllGlobals());

  it("a sell with no explicit token amount passes the check when there is a sound route (it used to be refused as '1080% away from the market')", async () => {
    vi.stubEnv("ZEROX_API_KEY", "");
    vi.stubGlobal("fetch", stub("ok", "ok"));
    const dex = new MultiEvmDexAdapter();
    expect(await dex.simulateSwap(sell)).toEqual({ ok: true });
    const q = await dex.getQuote(sell);
    expect(q.effectivePriceUsd).toBeCloseTo(0.8, 1); // price per token: $9.9 over 12.5 tokens, near the $0.80 market, not $9.9
    expect(q.priceImpactPct).toBeLessThan(2);
  });

  it("a rate-limited or erroring provider is 'unknown', never 'cannot be sold'", async () => {
    vi.stubEnv("ZEROX_API_KEY", "");
    for (const [p, k] of [[429, 429], [500, 503], [429, "ok"]] as const) {
      vi.stubGlobal("fetch", stub(p, k));
      const r = await new MultiEvmDexAdapter().simulateSwap(sell);
      if (k === "ok") expect(r.ok).toBe(true); // the other aggregator answered
      else expect(r).toMatchObject({ ok: false, unknown: true });
    }
  });

  it("every aggregator saying there is no route IS a conclusive failure; a mix is not", async () => {
    vi.stubEnv("ZEROX_API_KEY", "");
    vi.stubGlobal("fetch", stub(400, 404));
    expect(await new MultiEvmDexAdapter().simulateSwap(sell)).toMatchObject({ ok: false, unknown: false });
    vi.stubGlobal("fetch", stub(400, 503));
    expect(await new MultiEvmDexAdapter().simulateSwap(sell)).toMatchObject({ ok: false, unknown: true });
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

(dbUp ? describe : describe.skip)("how a failed sell check affects a buy", () => {
  const userId = newId();
  let token: TokenDoc;

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
    await (await collections.users()).insertOne({ _id: userId, email: `ss-${Date.now()}@test.local`, passwordHash: "x", name: null, role: "USER", createdAt: now });
    await (await collections.tradingAccounts()).insertOne({ _id: newId(), userId, environment: "LIVE", realizedPnlUsd: 0, createdAt: now });
    await (await collections.wallets()).insertOne({ _id: newId(), userId, chain: "solana", address: "W".repeat(44), label: null, verifiedAt: now, createdAt: now });
    await getSettings(userId);
    await (await collections.tradingSettings()).updateOne({ userId }, { $set: { minOpportunityScore: 0, minLiquidityUsd: 0, minVolume24hUsd: 0, maxPriceImpactPct: 50, maxAllowedRisk: "HIGH" } });
  });
  afterEach(() => vi.restoreAllMocks());
  afterAll(async () => {
    await Promise.all([(await collections.users()).deleteOne({ _id: userId }), (await collections.tradingAccounts()).deleteMany({ userId }), (await collections.wallets()).deleteMany({ userId }), (await collections.tradingSettings()).deleteMany({ userId })]).catch(() => {});
  });

  async function withSim(sim: { ok: boolean; error?: string; unknown?: boolean }) {
    const { providers } = await import("@/core/providers/registry");
    const dex = providers().dex;
    await (await collections.tokens()).updateOne({ _id: token._id }, { $set: { priceUsd: token.priceUsd, lastScannedAt: new Date() } });
    const real = dex.getQuote.bind(dex);
    vi.spyOn(dex, "getQuote").mockImplementation(async (req) => ({ ...(await real(req)), effectivePriceUsd: token.priceUsd, priceImpactPct: 0.3 }));
    vi.spyOn(dex, "simulateSwap").mockResolvedValue(sim);
  }
  const input = { chain: "solana" as const, tokenAddress: "", amountUsd: 5, slippageBps: 300, environment: "LIVE" as const };

  it("a REAL 'no sell route' still blocks the buy", async () => {
    const { quoteTrade } = await import("@/services/trading");
    await withSim({ ok: false, error: "No swap route found", unknown: false });
    const r = await quoteTrade(userId, { ...input, tokenAddress: token.address });
    expect(r.violations.join(" ")).toContain("Sell simulation failed");
  });

  it("an inconclusive check does NOT block a manual buy; it is flagged instead", async () => {
    const { quoteTrade } = await import("@/services/trading");
    await withSim({ ok: false, error: "HTTP 429 from lite-api.jup.ag", unknown: true });
    const r = await quoteTrade(userId, { ...input, tokenAddress: token.address });
    expect(r.violations.join(" ")).not.toContain("Sell simulation failed");
    expect(r.warnings.join(" ")).toContain("Couldn't double-check that this token can be sold");
  });

  it("the unattended bot does not buy on an unverified sell check: it retries", async () => {
    const { quoteTrade } = await import("@/services/trading");
    await withSim({ ok: false, error: "HTTP 429 from lite-api.jup.ag", unknown: true });
    const r = await quoteTrade(userId, { ...input, tokenAddress: token.address }, true);
    expect(r.violations.join(" ")).toContain("Couldn't verify the token can be sold right now");
    expect(r.violations.join(" ")).not.toContain("Sell simulation failed");
  });
});
