/**
 * "Simulation failed" when buying Solana tokens. Covers: classifying real simulation failures, explaining wallet errors,
 * the server-side dry run that stops a doomed swap before the wallet opens (and finds a slippage that works), and keeping
 * fee/rent headroom out of what counts as spendable.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("next/headers", () => ({ cookies: async () => ({ get: () => undefined, set: () => {}, delete: () => {} }) }));
vi.mock("@/lib/env", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/env")>()), liveTradingAllowed: () => true }));

import { explainSolanaSimulation } from "@/core/providers/solana/errors";
import { checkManualAmount } from "@/core/trading/capital";
import { closeDb, collections, newId } from "@/lib/db";
import type { TokenDoc } from "@/lib/models";
import { explainWalletError } from "@/lib/txErrors";

describe("explainSolanaSimulation (shapes captured from real simulations)", () => {
  it("slippage: Jupiter custom error 6001", () => {
    const f = explainSolanaSimulation({ InstructionError: [5, { Custom: 6001 }] }, ["Program JUP6Lkb... failed: custom program error: 0x1771"]);
    expect(f.kind).toBe("slippage");
    expect(f.message).toMatch(/slippage/i);
    expect(explainSolanaSimulation({ InstructionError: [2, { Custom: 6001 }] }).kind).toBe("slippage");
  });
  it("not enough SOL: says how much the wallet has and how much the swap needs", () => {
    const f = explainSolanaSimulation({ InstructionError: [3, { Custom: 1 }] }, ["Program 11111111111111111111111111111111 invoke [1]", "Transfer: insufficient lamports 38325766, need 66000000", "Program 11111111111111111111111111111111 failed: custom program error: 0x1"]);
    expect(f.kind).toBe("insufficient_sol");
    expect(f.message).toContain("0.0383 SOL available");
    expect(f.message).toContain("needs 0.066 SOL");
  });
  it("rent / fee shortfalls, an empty wallet, a lagging node, missing tokens, and anything else", () => {
    expect(explainSolanaSimulation("InsufficientFundsForRent").kind).toBe("insufficient_sol");
    expect(explainSolanaSimulation("AccountNotFound").kind).toBe("no_sol_account");
    expect(explainSolanaSimulation("BlockhashNotFound").kind).toBe("blockhash");
    expect(explainSolanaSimulation({ InstructionError: [4, { Custom: 1 }] }, ["Program TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA invoke [1]", "Program log: Error: insufficient funds"]).kind).toBe("insufficient_token");
    const other = explainSolanaSimulation({ InstructionError: [1, { Custom: 9999 }] });
    expect(other.kind).toBe("other");
    expect(other.message).toContain("9999");
  });
});

describe("explainWalletError", () => {
  it("recognises a declined transaction (not an error to alarm anyone with)", () => {
    expect(explainWalletError({ code: 4001, message: "User rejected the request." })).toMatch(/declined/);
    expect(explainWalletError(new Error("User rejected the request"))).toMatch(/declined/);
  });
  it("explains slippage, low SOL, expiry and a generic simulation failure, keeping the original text", () => {
    expect(explainWalletError(new Error("Transaction simulation failed: Error processing Instruction 5: custom program error: 0x1771"))).toMatch(/slippage/i);
    expect(explainWalletError({ message: "failed", logs: ["Transfer: insufficient lamports 5000, need 90000"] })).toMatch(/Not enough SOL: 0.0000 SOL available, 0.0001 SOL needed/);
    expect(explainWalletError(new Error("Blockhash not found"))).toMatch(/expired/);
    const generic = explainWalletError({ message: "Transaction simulation failed", logs: ["Program X invoke", "Program X failed: boom"] });
    expect(generic).toContain("would fail");
    expect(generic).toContain("boom");
    expect(explainWalletError(undefined)).toBe("Unknown wallet error");
    expect(explainWalletError("plain string error")).toBe("plain string error");
  });
});

describe("spendable amounts keep fee headroom", () => {
  it("a manual buy of the whole balance is refused with a clear reason, a buy that leaves headroom is fine", () => {
    const s = { maxPositionUsd: 1000, minPositionUsd: 1, maxOpenPositions: 5, maxDeployedUsd: null };
    const st = { deployedUsd: 0, openPositions: 0, walletUsd: 20 }; // what spendableUsd returns: balance already net of the reserve
    expect(checkManualAmount(s, st, 25)).toMatch(/wallet balance on this chain \(\$20.00 after keeping a little back for network fees\)/);
    expect(checkManualAmount(s, st, 19)).toBeNull();
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

(dbUp ? describe : describe.skip)("the dry run before the wallet opens", () => {
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
    await (await collections.users()).insertOne({ _id: userId, email: `pf-${Date.now()}@test.local`, passwordHash: "x", name: null, role: "USER", createdAt: now });
    await (await collections.tradingAccounts()).insertOne({ _id: newId(), userId, environment: "LIVE", realizedPnlUsd: 0, createdAt: now });
    await (await collections.wallets()).insertOne({ _id: newId(), userId, chain: "solana", address: "W".repeat(44), label: null, verifiedAt: now, createdAt: now });
    await getSettings(userId);
    await (await collections.tradingSettings()).updateOne({ userId }, { $set: { minOpportunityScore: 0, minLiquidityUsd: 0, minVolume24hUsd: 0, maxPriceImpactPct: 50, maxAllowedRisk: "HIGH", maxSlippageBps: 300 } });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    const { providers } = await import("@/core/providers/registry");
    delete (providers().dex as unknown as { preflight?: unknown }).preflight;
  });
  afterAll(async () => {
    await Promise.all([
      (await collections.users()).deleteOne({ _id: userId }), (await collections.tradingAccounts()).deleteMany({ userId }), (await collections.wallets()).deleteMany({ userId }),
      (await collections.tradingSettings()).deleteMany({ userId }), (await collections.trades()).deleteMany({ userId }),
    ]).catch(() => {});
  });

  /** quotes pinned to the listed price; the built "transaction" records the slippage it was built with; the fake dry run fails below `minOkBps` */
  async function setup(preflight: (tx: string) => { ok: true } | { ok: false; kind: string; error: string }) {
    const { providers } = await import("@/core/providers/registry");
    const dex = providers().dex;
    await (await collections.tokens()).updateOne({ _id: token._id }, { $set: { lastScannedAt: new Date() } });
    const real = dex.getQuote.bind(dex);
    vi.spyOn(dex, "getQuote").mockImplementation(async (req) => ({ ...(await real(req)), effectivePriceUsd: token.priceUsd, priceImpactPct: 0.3 }));
    vi.spyOn(dex, "buildSwapTransaction").mockImplementation(async (q) => ({ unsignedTxBase64: `tx-${q.slippageBps}` }));
    const pf = vi.fn(async (_c: string, tx: string) => preflight(tx));
    (dex as unknown as { preflight: typeof pf }).preflight = pf;
    return pf;
  }
  const input = (slippageBps: number) => ({ chain: "solana" as const, tokenAddress: token.address, amountUsd: 5, slippageBps, environment: "LIVE" as const });
  const slip = (tx: string) => Number(tx.replace("tx-", ""));
  const trades = async () => (await collections.trades()).countDocuments({ userId });

  it("a swap that passes the dry run is handed to the wallet", async () => {
    const { prepareTrade } = await import("@/services/trading");
    const pf = await setup(() => ({ ok: true }));
    const r = await prepareTrade(userId, input(300), "MANUAL_ENTRY");
    expect(r.unsignedTxBase64).toBe("tx-300");
    expect(pf).toHaveBeenCalledTimes(1);
  });

  it("slippage too tight: nothing is handed to the wallet, the error names the slippage that works, and the panel gets it as a hint", async () => {
    const { prepareTrade, TradeError } = await import("@/services/trading");
    const before = await trades();
    await setup((tx) => (slip(tx) >= 300 ? { ok: true } : { ok: false, kind: "slippage", error: "The price moved more than your slippage tolerance." }));
    const err = await prepareTrade(userId, input(100), "MANUAL_ENTRY").catch((e) => e);
    expect(err).toBeInstanceOf(TradeError);
    expect(err.status).toBe(422);
    expect(err.message).toMatch(/fails at 1.0% slippage but passes at 3.0%: set slippage to 3.0%/);
    expect(err.hint).toEqual({ slippageBps: 300 });
    expect(await trades()).toBe(before); // no trade was created
  });

  it("never goes above the user's own maximum slippage, and says so when even that fails", async () => {
    const { prepareTrade } = await import("@/services/trading");
    const pf = await setup(() => ({ ok: false, kind: "slippage", error: "The price moved more than your slippage tolerance." }));
    const err = await prepareTrade(userId, input(100), "MANUAL_ENTRY").catch((e) => e);
    expect(err.message).toMatch(/still fails at your maximum slippage \(3.0%\)/);
    expect(err.hint).toBeUndefined();
    const tried = pf.mock.calls.map((c) => slip(c[1]));
    expect(Math.max(...tried)).toBe(300); // 200 and 300 were tried, 500+ never
  });

  it("other failures (not enough SOL) are explained as they are, without retrying slippage", async () => {
    const { prepareTrade } = await import("@/services/trading");
    const before = await trades();
    const pf = await setup(() => ({ ok: false, kind: "insufficient_sol", error: "Not enough SOL: the wallet has 0.0383 SOL available but this swap needs 0.066 SOL." }));
    const err = await prepareTrade(userId, input(100), "MANUAL_ENTRY").catch((e) => e);
    expect(err.status).toBe(422);
    expect(err.message).toContain("Not enough SOL");
    expect(pf).toHaveBeenCalledTimes(1);
    expect(await trades()).toBe(before);
  });

  it("a queued buy gets the same dry run when refreshed at 'Review & sign'", async () => {
    const { prepareTrade, refreshPreparedTrade } = await import("@/services/trading");
    await setup(() => ({ ok: true }));
    const queued = await prepareTrade(userId, input(300), "AUTO_ENTRY");
    vi.restoreAllMocks();
    await setup(() => ({ ok: false, kind: "insufficient_sol", error: "Not enough SOL: test" }));
    await expect(refreshPreparedTrade(userId, queued.trade.id)).rejects.toMatchObject({ status: 422, message: expect.stringContaining("Not enough SOL") });
  });

  it("an adapter without a dry run (EVM, mock) just builds", async () => {
    const { prepareTrade } = await import("@/services/trading");
    await setup(() => ({ ok: true }));
    const { providers } = await import("@/core/providers/registry");
    delete (providers().dex as unknown as { preflight?: unknown }).preflight;
    expect((await prepareTrade(userId, input(300), "MANUAL_ENTRY")).unsignedTxBase64).toBe("tx-300");
  });
});
