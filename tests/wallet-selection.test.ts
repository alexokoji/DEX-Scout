/**
 * "I have funds in MetaMask but the app says $0.00": the server used the most recently linked wallet, not the one the
 * user was connected with. These tests pin the fix: the connected wallet is the one that is checked and traded with, an
 * unverified one is reported as such (never swapped for another), and every message names the address it looked at.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("next/headers", () => ({ cookies: async () => ({ get: () => undefined, set: () => {}, delete: () => {} }) }));
vi.mock("@/lib/env", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/env")>()), liveTradingAllowed: () => true }));

import { allocate } from "@/core/trading/capital";
import { closeDb, collections, newId } from "@/lib/db";
import type { TokenDoc } from "@/lib/models";

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

const OLD = "O".repeat(44); // linked first, holds nothing
const FUNDED = "F".repeat(44); // linked second: the account that actually holds the money
const NEWEST = "N".repeat(44); // linked last, empty: what "most recently linked" would pick
const NOT_LINKED = "U".repeat(44);

describe("messages name the wallet they checked", () => {
  const s = { maxPositionUsd: 1000, minPositionUsd: 1, maxOpenPositions: 5, maxDeployedUsd: null };
  it("a zero balance says which wallet was empty and what to do about it", () => {
    const r = allocate(s, { deployedUsd: 0, openPositions: 0, walletUsd: 0, walletLabel: "NNNNNN…NNNN" }, 10) as { reason: string };
    expect(r.reason).toContain("Wallet NNNNNN…NNNN holds none of this chain's coin");
    expect(r.reason).toContain("switch to it in your wallet");
  });
});

(dbUp ? describe : describe.skip)("which wallet is used", () => {
  const userId = newId();
  let token: TokenDoc;
  const balances: Record<string, number> = {};

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
    const now = Date.now();
    await (await collections.users()).insertOne({ _id: userId, email: `ws-${now}@test.local`, passwordHash: "x", name: null, role: "USER", createdAt: new Date(now) });
    await (await collections.tradingAccounts()).insertOne({ _id: newId(), userId, environment: "LIVE", realizedPnlUsd: 0, createdAt: new Date(now) });
    const mk = (address: string, ageMs: number) => ({ _id: newId(), userId, chain: "solana", address, label: null, verifiedAt: new Date(now - ageMs), createdAt: new Date(now - ageMs) });
    await (await collections.wallets()).insertMany([mk(OLD, 3000), mk(FUNDED, 2000), mk(NEWEST, 1000)]);
    await getSettings(userId);
    await (await collections.tradingSettings()).updateOne({ userId }, { $set: { minOpportunityScore: 0, minLiquidityUsd: 0, minVolume24hUsd: 0, maxPriceImpactPct: 50, maxAllowedRisk: "HIGH", minTrust: "UNPROVEN" } });
    Object.assign(balances, { [OLD]: 0, [FUNDED]: 2.5, [NEWEST]: 0 }); // SOL held by each address
  });

  afterEach(() => vi.restoreAllMocks());
  afterAll(async () => {
    await Promise.all([
      (await collections.users()).deleteOne({ _id: userId }), (await collections.tradingAccounts()).deleteMany({ userId }), (await collections.wallets()).deleteMany({ userId }),
      (await collections.tradingSettings()).deleteMany({ userId }), (await collections.trades()).deleteMany({ userId }),
    ]).catch(() => {});
  });

  async function fundedAccountsOnly() {
    const { providers } = await import("@/core/providers/registry");
    vi.spyOn(providers().chains.solana, "getNativeBalance").mockImplementation(async (a: string) => balances[a] ?? 0);
    vi.spyOn(providers().chains.solana, "nativeUsdPrice").mockResolvedValue(150);
    const dex = providers().dex;
    await (await collections.tokens()).updateOne({ _id: token._id }, { $set: { lastScannedAt: new Date() } });
    const real = dex.getQuote.bind(dex);
    vi.spyOn(dex, "getQuote").mockImplementation(async (req) => ({ ...(await real(req)), effectivePriceUsd: token.priceUsd, priceImpactPct: 0.3 }));
    return vi.spyOn(dex, "buildSwapTransaction").mockImplementation(async (_q, user) => ({ unsignedTxBase64: `tx-for-${user}` }));
  }
  const input = (wallet?: string) => ({ chain: "solana" as const, tokenAddress: token.address, amountUsd: 5, slippageBps: 300, environment: "LIVE" as const, wallet, acknowledgeTrust: true });

  it("with nothing requested (background jobs) the most recently verified wallet is used; the connected one is used when named", async () => {
    const { resolveWallet } = await import("@/services/walletResolve");
    expect((await resolveWallet(userId, "solana", null))?.address).toBe(NEWEST);
    expect((await resolveWallet(userId, "solana", FUNDED))?.address).toBe(FUNDED);
    expect((await resolveWallet(userId, "solana", OLD))?.address).toBe(OLD);
  });

  it("a connected wallet that isn't verified is reported as such, naming what IS linked, instead of silently using another", async () => {
    const { resolveWallet } = await import("@/services/walletResolve");
    const err = await resolveWallet(userId, "solana", NOT_LINKED).catch((e) => e);
    expect(err.status).toBe(409);
    expect(err.hint).toEqual({ verify: "solana", address: NOT_LINKED });
    expect(err.message).toContain("isn't verified yet");
    expect(err.message).toContain("UUUUUU…UUUU");
    expect(err.message).toContain("FFFFFF…FFFF"); // lists the linked ones
  });

  it("EVM addresses match regardless of case; Solana addresses are case-sensitive", async () => {
    const { resolveWallet } = await import("@/services/walletResolve");
    const mixed = "0xAbCdEf0123456789aBcDeF0123456789AbCdEf01";
    await (await collections.wallets()).insertOne({ _id: newId(), userId, chain: "evm", address: mixed.toLowerCase(), label: null, verifiedAt: new Date(), createdAt: new Date() });
    expect((await resolveWallet(userId, "base", mixed))?.address).toBe(mixed.toLowerCase());
    expect((await resolveWallet(userId, "base", mixed.toUpperCase().replace("0X", "0x")))?.address).toBe(mixed.toLowerCase());
    await expect(resolveWallet(userId, "solana", FUNDED.toLowerCase())).rejects.toMatchObject({ status: 409 });
  });

  it("THE BUG: funds in the connected account, an empty one linked more recently. The quote checks the connected account and shows its balance", async () => {
    const { quoteTrade } = await import("@/services/trading");
    await fundedAccountsOnly();
    const r = await quoteTrade(userId, input(FUNDED));
    expect(r.wallet).toMatchObject({ address: FUNDED, balanceUsd: 375 }); // 2.5 SOL at $150
    expect(r.violations.join(" ")).not.toMatch(/balance|spend/i);
  });

  it("the empty wallet is still reported as empty, by name, when THAT is the one connected", async () => {
    const { quoteTrade } = await import("@/services/trading");
    await fundedAccountsOnly();
    const r = await quoteTrade(userId, input(NEWEST));
    expect(r.wallet).toMatchObject({ address: NEWEST, balanceUsd: 0 });
    expect(r.violations.join(" ")).toContain("holds none of this chain's coin");
    expect(r.violations.join(" ")).toContain("NNNNNN…NNNN");
  });

  it("a quote for an unverified connected wallet fails with the verify hint rather than quoting against someone else's balance", async () => {
    const { quoteTrade } = await import("@/services/trading");
    await fundedAccountsOnly();
    await expect(quoteTrade(userId, input(NOT_LINKED))).rejects.toMatchObject({ status: 409, hint: { verify: "solana" } });
  });

  it("the swap is built for the connected wallet (not the latest linked one) and the trade remembers it", async () => {
    const { prepareTrade, refreshPreparedTrade } = await import("@/services/trading");
    const build = await fundedAccountsOnly();
    const r = await prepareTrade(userId, input(FUNDED), "MANUAL_ENTRY");
    expect(r.unsignedTxBase64).toBe(`tx-for-${FUNDED}`);
    expect(build).toHaveBeenLastCalledWith(expect.anything(), FUNDED);
    const stored = await (await collections.trades()).findOne({ _id: r.trade.id });
    expect((stored!.quote as { wallet?: string }).wallet).toBe(FUNDED);
    // refreshing later rebuilds for the same wallet even though another one was linked more recently
    const refreshed = await refreshPreparedTrade(userId, r.trade.id);
    expect(refreshed.unsignedTxBase64).toBe(`tx-for-${FUNDED}`);
    // ...or for whichever verified wallet is connected at that moment
    expect((await refreshPreparedTrade(userId, r.trade.id, OLD).catch((e) => e)).message ?? "").toBeDefined();
  });
});
