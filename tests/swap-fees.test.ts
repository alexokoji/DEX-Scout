/**
 * "The network fees should come from the actual on-chain price, not set by you." Fees and the amount kept back are now
 * measured from the chain. These tests pin the maths with figures taken from the live chain (rent 1,488,440 lamports,
 * base fee 5,000, priority fees currently 0) and the plumbing around it.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("next/headers", () => ({ cookies: async () => ({ get: () => undefined, set: () => {}, delete: () => {} }) }));
vi.mock("@/lib/env", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/env")>()), liveTradingAllowed: () => true }));

import { MAX_AUTO_PRIORITY_LAMPORTS, percentile, priorityLamports, readSolanaCosts, SWAP_COMPUTE_UNITS, swapReserveLamports, TOKEN_ACCOUNT_BYTES, type FeeConnection } from "@/core/providers/solana/fees";
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
  it("follows the 75th percentile of recent per-slot fees, converted to lamports for a swap's compute budget", () => {
    const fees = [...Array(100).fill(0), ...Array(50).fill(20_000)]; // a third of slots paid 20,000 micro-lamports/CU
    expect(percentile(fees, 0.75)).toBe(20_000);
    expect(priorityLamports(fees)).toBe(Math.ceil((20_000 * SWAP_COMPUTE_UNITS) / 1_000_000)); // 6,000 lamports
    expect(priorityLamports(fees)).toBe(6_000);
  });
  it("a user-set cap limits it; an extreme spike is limited too", () => {
    const busy = Array(150).fill(50_000_000); // 50,000,000 micro-lamports/CU x 300k CU = 0.015 SOL for one swap: a spike worth limiting
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
    expect(await readSolanaCosts(conn({ rent: 2_039_280, base: 7_500, fees: Array(150).fill(10_000) }))).toEqual({ baseFeeLamports: 7_500, priorityFeeLamports: 3_000, rentLamports: 2_039_280 });
  });
  it("honours a user cap on the priority fee", async () => {
    expect((await readSolanaCosts(conn({ fees: Array(150).fill(10_000) }), 1_000)).priorityFeeLamports).toBe(1_000);
  });
});

describe("EVM gas from the chain's current gas price", () => {
  afterEach(() => vi.unstubAllGlobals());
  const rpc = (gasPriceHex: string | null) =>
    vi.stubGlobal("fetch", async (_u: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "{}"));
      if (body.method === "eth_gasPrice" && gasPriceHex) return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: gasPriceHex }), { status: 200 });
      return new Response("down", { status: 500 });
    });

  it("is the current gas price x a swap's gas units (with a margin for it moving), in the native coin", async () => {
    const { evmSwapFeeNative, SWAP_GAS_UNITS } = await import("@/core/providers/evm/evmProviders");
    rpc("0x3b9aca00"); // 1 gwei
    const fee = await evmSwapFeeNative("arbitrum");
    expect(fee).toBeCloseTo((1e9 * SWAP_GAS_UNITS * 1.25) / 1e18, 12);
  });
  it("is unknown (null), never a made-up number, when the gas price can't be read", async () => {
    const { evmSwapFeeNative, evmGasPriceWei } = await import("@/core/providers/evm/evmProviders");
    rpc(null);
    expect(await evmGasPriceWei("optimism")).toBeNull();
    expect(await evmSwapFeeNative("optimism")).toBeNull();
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
