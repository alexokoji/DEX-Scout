/**
 * Unattended trading end to end against the embedded MongoDB: the bot wallet, the server signing a trade that was prepared for it, the
 * safeguards around that signing, and the daily governor deciding whether the bot may open anything. Chain calls are stubbed; what is
 * pinned is what the app does with them.
 */
import { Keypair, PublicKey } from "@solana/web3.js";
import bs58 from "bs58";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  process.env.BOT_WALLET_KEY = Buffer.alloc(32, 5).toString("base64");
});
vi.mock("next/headers", () => ({ cookies: async () => ({ get: () => undefined, set: () => {}, delete: () => {} }) }));
vi.mock("@/lib/env", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/env")>()), liveTradingAllowed: () => true }));
const chain = vi.hoisted(() => ({ sendRawTransaction: vi.fn(async () => "sig") }));
vi.mock("@/core/providers/solana/solanaProviders", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/core/providers/solana/solanaProviders")>()),
  solanaTry: vi.fn(async (fn: (c: unknown) => unknown) => fn(chain)),
}));
vi.mock("@/core/providers/solana/reclaim", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/core/providers/solana/reclaim")>()),
  emptyTokenAccounts: vi.fn(),
  closableAccounts: vi.fn(),
  closeTransactions: vi.fn(),
}));
vi.mock("@/core/providers/evm/botSigner", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/core/providers/evm/botSigner")>()),
  signEvmCall: vi.fn(),
  sendEvmRaw: vi.fn(),
  waitForEvmReceipt: vi.fn(),
}));

import { openSecretFor } from "./botWalletTestHelper";
import { buildSolTransfer } from "@/core/providers/solana/botSigner";
import { providers } from "@/core/providers/registry";
import * as evmSigner from "@/core/providers/evm/botSigner";
import * as reclaim from "@/core/providers/solana/reclaim";
import { closeDb, collections, newId } from "@/lib/db";
import { hashPassword } from "@/lib/auth";
import type { PositionDoc, TokenDoc, TradeDoc } from "@/lib/models";

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

const HASH = (c: string) => "0x" + c.repeat(32);

(dbUp ? describe : describe.skip)("unattended trading", () => {
  const userId = newId();
  const created = { tokens: [] as string[] };
  let template: TokenDoc;
  let accountId = "";
  let botSol = "";
  let botEvm = "";
  const OWN_SOL = Keypair.generate().publicKey.toBase58();

  async function makeToken(chain: string, priceUsd = 0.01): Promise<TokenDoc> {
    const _id = newId();
    created.tokens.push(_id);
    const t = { ...template, _id, chain, address: chain === "solana" ? Keypair.generate().publicKey.toBase58() : `0x${_id.replace(/-/g, "")}00000000`.slice(0, 42), symbol: "BOTX", priceUsd, passedFilters: true, lastScannedAt: new Date() } as TokenDoc;
    await (await collections.tokens()).insertOne(t);
    return t;
  }
  async function makePosition(token: TokenDoc, wallet: string, over: Partial<PositionDoc> = {}): Promise<PositionDoc> {
    const now = new Date();
    const p = {
      _id: newId(), userId, accountId, tokenId: token._id, environment: "LIVE", status: "OPEN", health: "HOLD", healthNotes: null, origin: "AUTO", sourceSignalId: null,
      entryPriceUsd: 0.01, currentPriceUsd: 0.0105, initialAmount: 1000, amount: 1000, investedUsd: 10, costBasisUsd: 10, realizedPnlUsd: 0, targetsHit: 0, walletAddress: wallet,
      targetsSnapshot: [{ level: 1, gainPct: 3, sellPct: 100 }], emergencyEnabled: false, emergencyAutoExit: false, openedAt: now, updatedAt: now, closedAt: null, lastAnalysisAt: null, ...over,
    } as PositionDoc;
    await (await collections.positions()).insertOne(p);
    return p;
  }
  const solTx = () => Buffer.from(buildSolTransfer(new PublicKey(botSol), Keypair.generate().publicKey, 1, bs58.encode(Buffer.alloc(32, 3))).serialize()).toString("base64");
  const quote = (chain: string) => ({ chain, inputMint: "a", outputMint: "b", inputAmountUsd: 10, outputAmount: 1, effectivePriceUsd: 0.0105, priceImpactPct: 0.1, slippageBps: 300, minReceived: 1, networkFeeUsd: 0.001, priorityFeeUsd: 0, platformFeeUsd: 0, route: [], expiresAt: new Date(Date.now() + 60_000), raw: null, source: "LIVE" });
  const tradeOf = async (id: string) => (await (await collections.trades()).findOne({ _id: id })) as TradeDoc;
  const notes = async (type: string) => (await collections.notifications()).find({ userId, type: type as never }).toArray();

  /** the chain stubs for a Solana sale: a quote, a transaction the bot wallet pays for, and "not on-chain yet" */
  function stubSolana() {
    vi.spyOn(providers().dex, "getQuote").mockImplementation(async (r) => quote(r.chain) as never);
    vi.spyOn(providers().dex, "buildSwapTransaction").mockImplementation(async () => ({ unsignedTxBase64: solTx() }));
    vi.spyOn(providers().dex, "getTransactionStatus").mockResolvedValue({ status: "NOT_FOUND" });
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
    await (await collections.users()).insertOne({ _id: userId, email: `bw-${Date.now()}@test.local`, passwordHash: await hashPassword("correct horse"), name: null, role: "USER", createdAt: now });
    accountId = newId();
    await (await collections.tradingAccounts()).insertOne({ _id: accountId, userId, environment: "LIVE", realizedPnlUsd: 0, createdAt: now });
    await (await collections.wallets()).insertOne({ _id: newId(), userId, chain: "solana", address: OWN_SOL, label: null, verifiedAt: now, createdAt: now });
    const { ensureBotWallet } = await import("@/services/botWallet");
    botSol = (await ensureBotWallet(userId, "solana")).address;
    botEvm = (await ensureBotWallet(userId, "evm")).address;
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.mocked(evmSigner.signEvmCall).mockReset();
    vi.mocked(evmSigner.sendEvmRaw).mockReset();
    vi.mocked(evmSigner.waitForEvmReceipt).mockReset();
  });
  afterAll(async () => {
    await Promise.all([
      (await collections.users()).deleteOne({ _id: userId }), (await collections.tradingAccounts()).deleteMany({ userId }), (await collections.wallets()).deleteMany({ userId }),
      (await collections.botWallets()).deleteMany({ userId }), (await collections.positions()).deleteMany({ userId }), (await collections.trades()).deleteMany({ userId }),
      (await collections.notifications()).deleteMany({ userId }), (await collections.tradingSettings()).deleteMany({ userId }), (await collections.bots()).deleteMany({ userId }),
      (await collections.botRuns()).deleteMany({}).catch(() => {}), (await collections.tokens()).deleteMany({ _id: { $in: created.tokens } }),
    ]).catch(() => {});
  });

  describe("the bot wallet", () => {
    it("is created once per address family, and what is stored isn't the secret", async () => {
      const { ensureBotWallet } = await import("@/services/botWallet");
      expect((await ensureBotWallet(userId, "solana")).address).toBe(botSol); // asking again returns the same wallet
      const doc = (await (await collections.botWallets()).findOne({ userId, family: "solana" }))!;
      const secret = openSecretFor(doc);
      expect(JSON.stringify(doc)).not.toContain(bs58.encode(secret));
      expect(Keypair.fromSecretKey(Uint8Array.from(secret)).publicKey.toBase58()).toBe(botSol);
    });
    it("a sealed key copied onto another user's record does not open", async () => {
      const { openSecret } = await import("@/services/botWallet");
      const doc = (await (await collections.botWallets()).findOne({ userId, family: "solana" }))!;
      expect(() => openSecret({ ...doc, userId: "someone-else" })).toThrow();
    });
    it("is a wallet the user owns when asked for by address, and no other address is", async () => {
      const { resolveWallet } = await import("@/services/walletResolve");
      expect((await resolveWallet(userId, "solana", botSol))?.label).toBe("bot wallet");
      await expect(resolveWallet(userId, "solana", Keypair.generate().publicKey.toBase58())).rejects.toMatchObject({ status: 409 });
    });
    it("can be emptied only to a wallet the user has verified", async () => {
      const { withdrawNative } = await import("@/services/botWallet");
      await expect(withdrawNative(userId, "solana", Keypair.generate().publicKey.toBase58())).rejects.toMatchObject({ status: 409, message: expect.stringMatching(/verified/) });
    });
    it("exports its key only with the account password", async () => {
      const { exportBotKey } = await import("@/services/botWallet");
      await expect(exportBotKey(userId, "solana", "wrong")).rejects.toMatchObject({ status: 403 });
      const r = await exportBotKey(userId, "solana", "correct horse");
      expect(Keypair.fromSecretKey(bs58.decode(r.secret)).publicKey.toBase58()).toBe(botSol);
      expect((await (await collections.botWallets()).findOne({ userId, family: "solana" }))!.exportedAt).toBeInstanceOf(Date);
    });
  });

  describe("signing a trade prepared for the bot wallet (Solana)", () => {
    it("signs, records the signature BEFORE sending, and leaves the trade pending for the normal confirmation", async () => {
      stubSolana();
      const { botSell } = await import("@/services/autonomous");
      const token = await makeToken("solana");
      const pos = await makePosition(token, botSol);
      let seenAtSend: { status: string; signature: string | null } | null = null;
      const send = vi.spyOn(providers().dex, "executeSwap").mockImplementation(async (_c, signedB64) => {
        const t = await (await collections.trades()).findOne({ positionId: pos._id, side: "SELL" });
        seenAtSend = { status: t!.status, signature: t!.transaction?.signature ?? null };
        void signedB64;
        return { signature: "x" };
      });
      const r = await botSell(userId, pos._id, 1000, "TARGET_EXIT", "Target 1 reached", 1);
      expect(r).toMatchObject({ ok: true, status: "SENT" });
      expect(send).toHaveBeenCalledTimes(1);
      expect(seenAtSend).toMatchObject({ status: "PENDING", signature: r.signature }); // already recorded when it went out
      const trade = await (await collections.trades()).findOne({ positionId: pos._id, side: "SELL" });
      expect(trade!.transaction!.signature).toBe(r.signature);
      expect(trade!.botClaimedAt).toBeInstanceOf(Date);
      // no approval queue, no "sell ready to sign" notification: nobody has to sign. The user is told it has gone out, straight away.
      expect(await notes("SELL_QUEUED")).toHaveLength(0);
      const sent = await notes("BOT_ACTIVITY");
      expect(sent.some((n) => n.title === "Bot is selling BOTX" && /Target 1 reached/.test(n.body))).toBe(true);
    });

    it("signs a trade at most once, even when asked twice at the same moment", async () => {
      stubSolana();
      const { executeBotTrade } = await import("@/services/autonomous");
      const { prepareLiveSell } = await import("@/services/trading");
      const token = await makeToken("solana");
      const pos = await makePosition(token, botSol);
      const send = vi.spyOn(providers().dex, "executeSwap").mockResolvedValue({ signature: "x" });
      const { trade } = await prepareLiveSell(userId, pos._id, 1000, "MANUAL_EXIT", "x", undefined, undefined, { autonomous: true });
      const [a, b] = await Promise.all([executeBotTrade(userId, trade.id), executeBotTrade(userId, trade.id)]);
      expect([a.status, b.status].sort()).toEqual(["ALREADY_HANDLED", "SENT"]);
      expect(send).toHaveBeenCalledTimes(1);
    });

    it("will not sign a trade that wasn't prepared for the bot wallet, whatever it is", async () => {
      stubSolana();
      const { executeBotTrade } = await import("@/services/autonomous");
      const token = await makeToken("solana");
      const send = vi.spyOn(providers().dex, "executeSwap").mockResolvedValue({ signature: "x" });
      const id = newId();
      await (await collections.trades()).insertOne({
        _id: id, userId, accountId, tokenId: token._id, positionId: null, side: "BUY", kind: "MANUAL_ENTRY", environment: "LIVE", dataSource: "MOCK", status: "PREPARED", inputUsd: 10, tokenAmount: 1, priceUsd: 0.01,
        priceImpactPct: 0, slippageBps: 100, feesUsd: 0, networkFeeUsd: 0, realizedPnlUsd: null, quote: { wallet: OWN_SOL }, failureReason: null, expiresAt: new Date(Date.now() + 60_000), createdAt: new Date(), executedAt: null,
        transaction: { chain: "solana", signature: null, status: "PENDING", unsignedTx: solTx(), error: null, slot: null, submittedAt: null, confirmedAt: null, createdAt: new Date() },
      } as never);
      await expect(executeBotTrade(userId, id)).rejects.toMatchObject({ status: 403 });
      expect(send).not.toHaveBeenCalled();
      expect((await tradeOf(id)).status).toBe("PREPARED"); // untouched
    });

    it("a send that fails fails the trade; a sale that couldn't be made is reported, and the sale is not repeated while one is already confirming", async () => {
      stubSolana();
      const { botSell } = await import("@/services/autonomous");
      const token = await makeToken("solana");
      const pos = await makePosition(token, botSol);
      vi.spyOn(providers().dex, "executeSwap").mockRejectedValue(new Error("Blockhash not found"));
      const r = await botSell(userId, pos._id, 1000, "TARGET_EXIT", "Target 1 reached", 1);
      expect(r).toMatchObject({ ok: false, status: "FAILED" });
      const trade = (await (await collections.trades()).findOne({ positionId: pos._id }))!;
      expect(trade.status).toBe("FAILED");
      expect(trade.failureReason).toMatch(/Blockhash/);
      expect((await notes("TRADE_FAILED")).some((n) => /could not sell/i.test(n.title))).toBe(true);

      // a sale already sent and confirming: asking again sends nothing
      const pos2 = await makePosition(token, botSol);
      await (await collections.trades()).insertOne({ ...trade, _id: newId(), positionId: pos2._id, status: "PENDING", failureReason: null, transaction: { ...trade.transaction!, signature: "5" + "a".repeat(86), status: "PENDING" } } as never);
      const again = vi.spyOn(providers().dex, "executeSwap").mockResolvedValue({ signature: "x" });
      const sent = again.mock.calls.length;
      expect(await botSell(userId, pos2._id, 1000, "TARGET_EXIT", "Target 1 reached", 1)).toMatchObject({ ok: true, status: "ALREADY_HANDLED" });
      expect(again.mock.calls.length).toBe(sent);
    });
  });

  describe("signing a trade prepared for the bot wallet (EVM)", () => {
    const payload = (token: string, withApproval: boolean) =>
      JSON.stringify({ chainId: 8453, ...(withApproval ? { approval: { to: token, data: "0xapprove", value: "0x0" } } : {}), tx: { to: "0x" + "cd".repeat(20), data: "0xswap", value: "0x0" }, swapGasUnits: "200000" });

    it("sends the approval, waits for it, then signs and records the swap before sending it; a slow approval resumes on the next run without a second approval", async () => {
      const { botSell, resumeBotTrades } = await import("@/services/autonomous");
      const token = await makeToken("base");
      const pos = await makePosition(token, botEvm);
      vi.spyOn(providers().dex, "getQuote").mockImplementation(async (r) => quote(r.chain) as never);
      vi.spyOn(providers().dex, "buildSwapTransaction").mockImplementation(async () => ({ unsignedTxBase64: payload(token.address, true) }));
      vi.spyOn(providers().dex, "getTransactionStatus").mockResolvedValue({ status: "NOT_FOUND" });
      const signed = vi.mocked(evmSigner.signEvmCall);
      signed.mockResolvedValueOnce({ raw: "0xapprovalraw", hash: HASH("11") as never, nonce: 0, maxFeeWei: BigInt(1) });
      signed.mockResolvedValueOnce({ raw: "0xswapraw", hash: HASH("22") as never, nonce: 1, maxFeeWei: BigInt(1) });
      let swapSeenAtSend: { status: string; signature: string | null } | null = null;
      vi.mocked(evmSigner.sendEvmRaw).mockImplementation(async (_c, raw) => {
        if (raw === "0xswapraw") {
          const t = await (await collections.trades()).findOne({ positionId: pos._id, side: "SELL" });
          swapSeenAtSend = { status: t!.status, signature: t!.transaction?.signature ?? null };
        }
        return raw === "0xapprovalraw" ? HASH("11") : HASH("22");
      });
      vi.mocked(evmSigner.waitForEvmReceipt).mockResolvedValueOnce(null); // the approval hasn't been mined yet

      const first = await botSell(userId, pos._id, 1000, "TARGET_EXIT", "Target 1 reached", 1);
      expect(first).toMatchObject({ ok: true, status: "WAITING_APPROVAL" });
      let trade = (await (await collections.trades()).findOne({ positionId: pos._id, side: "SELL" }))!;
      expect(trade.status).toBe("PREPARED");
      expect(trade.botApprovalHash).toBe(HASH("11"));
      expect(trade.botClaimedAt ?? null).toBeNull(); // released: the next run can take it
      expect(vi.mocked(evmSigner.sendEvmRaw)).toHaveBeenCalledTimes(1); // only the approval so far

      vi.mocked(evmSigner.waitForEvmReceipt).mockResolvedValueOnce(true); // mined now
      expect(await resumeBotTrades()).toBe(1);
      trade = (await (await collections.trades()).findOne({ positionId: pos._id, side: "SELL" }))!;
      expect(trade.status).toBe("PENDING");
      expect(trade.transaction!.signature).toBe(HASH("22"));
      expect(swapSeenAtSend).toMatchObject({ status: "PENDING", signature: HASH("22") }); // recorded before the swap went out
      expect(signed).toHaveBeenCalledTimes(2); // one approval and one swap: the approval was not signed again
    });

    it("an approval that fails on-chain fails the trade", async () => {
      const { botSell } = await import("@/services/autonomous");
      const token = await makeToken("base");
      const pos = await makePosition(token, botEvm);
      vi.spyOn(providers().dex, "getQuote").mockImplementation(async (r) => quote(r.chain) as never);
      vi.spyOn(providers().dex, "buildSwapTransaction").mockImplementation(async () => ({ unsignedTxBase64: payload(token.address, true) }));
      vi.mocked(evmSigner.signEvmCall).mockResolvedValue({ raw: "0xa", hash: HASH("33") as never, nonce: 0, maxFeeWei: BigInt(1) });
      vi.mocked(evmSigner.sendEvmRaw).mockResolvedValue(HASH("33"));
      vi.mocked(evmSigner.waitForEvmReceipt).mockResolvedValue(false);
      expect(await botSell(userId, pos._id, 1000, "TARGET_EXIT", "x", 1)).toMatchObject({ ok: false, status: "FAILED" });
      expect((await (await collections.trades()).findOne({ positionId: pos._id }))!.status).toBe("FAILED");
    });

    it("with the approval already in place there is just the swap", async () => {
      const { botSell } = await import("@/services/autonomous");
      const token = await makeToken("base");
      const pos = await makePosition(token, botEvm);
      vi.spyOn(providers().dex, "getQuote").mockImplementation(async (r) => quote(r.chain) as never);
      vi.spyOn(providers().dex, "buildSwapTransaction").mockImplementation(async () => ({ unsignedTxBase64: payload(token.address, false) }));
      vi.spyOn(providers().dex, "getTransactionStatus").mockResolvedValue({ status: "NOT_FOUND" });
      vi.mocked(evmSigner.signEvmCall).mockResolvedValue({ raw: "0xswapraw", hash: HASH("44") as never, nonce: 0, maxFeeWei: BigInt(1) });
      vi.mocked(evmSigner.sendEvmRaw).mockResolvedValue(HASH("44"));
      expect(await botSell(userId, pos._id, 1000, "TARGET_EXIT", "x", 1)).toMatchObject({ ok: true, status: "SENT", signature: HASH("44") });
      expect(vi.mocked(evmSigner.signEvmCall)).toHaveBeenCalledTimes(1);
      expect(vi.mocked(evmSigner.waitForEvmReceipt)).not.toHaveBeenCalled();
    });
  });

  describe("the deposits of what the bot has sold", () => {
    it("the bot closes the empty token accounts it leaves behind, but only looks once a position of its wallet has closed", async () => {
      const { sweepBotDeposits } = await import("@/services/botWallet");
      const acct = { address: Keypair.generate().publicKey.toBase58(), mint: "m", program: "p", lamports: 2_039_280 };
      vi.mocked(reclaim.emptyTokenAccounts).mockResolvedValue([acct]);
      vi.mocked(reclaim.closableAccounts).mockResolvedValue([acct]);
      vi.mocked(reclaim.closeTransactions).mockResolvedValue([{ transaction: solTx(), accounts: 1, lamports: acct.lamports }]);
      const wallets = await collections.botWallets();
      await wallets.updateOne({ userId, family: "solana" }, { $set: { sweptAt: new Date(Date.now() + 60_000) } }); // everything before now has been looked at
      expect(await sweepBotDeposits(userId)).toEqual({ closed: 0, lamports: 0 });
      expect(reclaim.emptyTokenAccounts).not.toHaveBeenCalled(); // nothing closed since: no look at all

      await wallets.updateOne({ userId, family: "solana" }, { $set: { sweptAt: new Date(Date.now() - 3_600_000) } });
      const token = await makeToken("solana");
      await makePosition(token, botSol, { status: "CLOSED", amount: 0, closedAt: new Date() });
      chain.sendRawTransaction.mockClear();
      expect(await sweepBotDeposits(userId)).toEqual({ closed: 1, lamports: 2_039_280 });
      expect(chain.sendRawTransaction).toHaveBeenCalledTimes(1); // signed by the bot wallet and sent
      expect((await wallets.findOne({ userId, family: "solana" }))!.sweptAt!.getTime()).toBeGreaterThan(Date.now() - 60_000);
      expect(await sweepBotDeposits(userId)).toEqual({ closed: 0, lamports: 0 }); // looked at: not again until another position closes
    });
  });

  describe("the monitor and the close button sell a bot-wallet position themselves", () => {
    it("a target reached on a bot position is sold at once; the same position held in the user's wallet only queues a sell to sign", async () => {
      stubSolana();
      const { monitorPosition } = await import("@/services/positionMonitor");
      vi.spyOn(providers().dex, "executeSwap").mockResolvedValue({ signature: "x" });
      // selling 1,000 tokens bought at $0.01 ($10) would bring $11.10: well clear of the fees
      vi.spyOn(providers().dex, "getQuote").mockImplementation(async (r) => ({ ...quote(r.chain), outputAmount: 11.1 }) as never);
      const snap = (token: TokenDoc) => vi.spyOn(providers().data, "getSnapshot").mockImplementation(async () => ({ ...template, chain: token.chain, address: token.address, priceUsd: 0.0111, liquidityUsd: 900_000, liquidity1hAgoUsd: 900_000, poolCreatedAt: new Date(), observedAt: new Date() }) as never);
      const t1 = await makeToken("solana", 0.0111);
      snap(t1);
      const bot = await makePosition(t1, botSol); // entry 0.01: +11%, past the +3% target
      await monitorPosition(bot, t1);
      expect(await (await collections.trades()).countDocuments({ positionId: bot._id, side: "SELL", status: "PENDING" })).toBe(1);
      expect(await notes("SELL_QUEUED")).toHaveLength(0);

      const t2 = await makeToken("solana", 0.0111);
      snap(t2);
      const own = await makePosition(t2, OWN_SOL);
      await monitorPosition(own, t2);
      const queued = await (await collections.trades()).findOne({ positionId: own._id, side: "SELL" });
      expect(queued!.status).toBe("PREPARED"); // waits for the user's wallet
      expect((await notes("SELL_QUEUED")).length).toBe(1);
    });
  });

  describe("a target is only sold if it is still a profit after the fee to buy and the fee to sell", () => {
    it("a gain thinner than the fees waits, and says why on the position; a real one sells", async () => {
      stubSolana();
      const { monitorPosition } = await import("@/services/positionMonitor");
      vi.spyOn(providers().dex, "executeSwap").mockResolvedValue({ signature: "x" });
      const token = await makeToken("solana", 0.0111);
      vi.spyOn(providers().data, "getSnapshot").mockImplementation(async () => ({ ...template, chain: token.chain, address: token.address, priceUsd: 0.0111, liquidityUsd: 900_000, liquidity1hAgoUsd: 900_000, poolCreatedAt: new Date(), observedAt: new Date() }) as never);
      const pos = await makePosition(token, botSol); // cost $10; the price target (+3%) has been reached
      // the buy that opened it paid $0.30 in fees, and the sale would bring $10.30 less a $0.30 fee: the price gain is eaten
      await (await collections.trades()).insertOne({
        _id: newId(), userId, accountId, tokenId: token._id, positionId: pos._id, side: "BUY", kind: "AUTO_ENTRY", environment: "LIVE", dataSource: "LIVE", status: "CONFIRMED", inputUsd: 10, tokenAmount: 1000, priceUsd: 0.01,
        priceImpactPct: 0, slippageBps: 100, feesUsd: 0, networkFeeUsd: 0.3, realizedPnlUsd: null, quote: { wallet: botSol }, failureReason: null, expiresAt: null, createdAt: new Date(), executedAt: new Date(), transaction: null,
      } as never);
      const send = vi.spyOn(providers().dex, "getQuote").mockImplementation(async (r) => ({ ...quote(r.chain), outputAmount: 10.3, networkFeeUsd: 0.3 }) as never);
      const sells = async () => (await collections.trades()).countDocuments({ positionId: pos._id, side: "SELL" });
      await monitorPosition(pos, token);
      expect(await sells()).toBe(0); // up 3% on price, down after $0.60 of fees
      const waitEvent = await (await collections.positionEvents()).findOne({ positionId: pos._id, type: "FEES_WAIT" });
      expect(waitEvent!.message).toMatch(/waiting for a higher price/);
      expect(waitEvent!.message).toMatch(/to sell/);
      // asked again straight away: it doesn't pile up another note
      await monitorPosition((await (await collections.positions()).findOne({ _id: pos._id }))!, token);
      expect(await (await collections.positionEvents()).countDocuments({ positionId: pos._id, type: "FEES_WAIT" })).toBe(1);

      // the price has climbed: the sale now brings $11.00, comfortably more than the cost and both fees
      send.mockImplementation(async (r) => ({ ...quote(r.chain), outputAmount: 11, networkFeeUsd: 0.3 }) as never);
      await monitorPosition((await (await collections.positions()).findOne({ _id: pos._id }))!, token);
      expect(await sells()).toBe(1);
      await (await collections.trades()).deleteMany({ positionId: pos._id, side: "BUY" }); // not part of the day's tally in the governor tests below
    });
  });

  describe("the daily governor", () => {
    it("adds up what the bot wallet did today, net of fees, and stops the bot opening trades when the loss limit is reached", async () => {
      const { autonomousStatus, dayEventsFor } = await import("@/services/autonomous");
      const { getSettings, updateAutonomous } = await import("@/services/settings");
      await updateAutonomous(userId, { enabled: true, dailyTargetUsd: 5, dailyLossLimitUsd: 1, givebackPct: 30, maxConsecutiveLosses: 3, cooldownMinutes: 30, entryMaxRangePct: 35, dayOffsetMinutes: 0 });
      const token = await makeToken("solana");
      const pos = await makePosition(token, botSol, { status: "CLOSED", amount: 0, closedAt: new Date() });
      const now = new Date();
      const sell = (realized: number, fee: number): TradeDoc => ({
        _id: newId(), userId, accountId, tokenId: token._id, positionId: pos._id, side: "SELL", kind: "TARGET_EXIT", environment: "LIVE", dataSource: "LIVE", status: "CONFIRMED", inputUsd: 10, tokenAmount: 1, priceUsd: 0.01,
        priceImpactPct: 0, slippageBps: 100, feesUsd: 0, networkFeeUsd: fee, realizedPnlUsd: realized, quote: { wallet: botSol }, failureReason: null, expiresAt: null, createdAt: now, executedAt: now, transaction: null,
        walletChange: { nativeDelta: 0, feeNative: fee / 100, depositNative: 0, nativeUsd: 100 },
      }) as TradeDoc;
      await (await collections.trades()).insertMany([sell(-0.4, 0.002), sell(-0.7, 0.002)]);
      const events = await dayEventsFor(userId, new Date(now.getTime() - 3_600_000));
      expect(events).toHaveLength(2);
      expect(events.reduce((s, e) => s + e.netUsd, 0)).toBeCloseTo(-0.4 - 0.7 - 0.004, 6); // fees are the wallet's real ones
      expect(events.filter((e) => e.closed)).toHaveLength(1); // only the last sale of a position is the one that closed it

      const status = await autonomousStatus(userId, await getSettings(userId));
      expect(status.decision.state).toBe("LOSS_LIMIT");
      expect(status.decision.canOpen).toBe(false);
    });

    it("the bot cycle then opens nothing, and says why", async () => {
      const { runBotCycle } = await import("@/services/bot");
      await (await collections.tradingSettings()).updateOne({ userId }, { $set: { environment: "LIVE", autoTradingEnabled: true } });
      await (await collections.bots()).updateOne({ userId }, { $set: { status: "ACTIVE", environment: "LIVE" }, $setOnInsert: { _id: newId(), userId, lastRunAt: null, emergencyStoppedAt: null, createdAt: new Date() } }, { upsert: true });
      const before = await (await collections.trades()).countDocuments({ userId });
      await runBotCycle();
      expect(await (await collections.trades()).countDocuments({ userId })).toBe(before);
      const bot = (await (await collections.bots()).findOne({ userId }))!;
      const run = await (await collections.botRuns()).findOne({ botId: bot._id }, { sort: { startedAt: -1 } });
      expect(JSON.stringify(run?.summary)).toMatch(/loss limit/);
      expect((await notes("SYSTEM_ALERT")).some((n) => /loss limit/i.test(n.title))).toBe(true);
    });
  });

  describe("switching it on and off", () => {
    it("on needs a bot wallet and puts the bot in LIVE and running; off pauses it, so it doesn't fall back to asking for approvals", async () => {
      const { setAutonomous } = await import("@/services/autonomous");
      const input = { enabled: true, dailyTargetUsd: 5, dailyLossLimitUsd: 3, givebackPct: 30, maxConsecutiveLosses: 3, cooldownMinutes: 30, entryMaxRangePct: 35, dayOffsetMinutes: 0 };
      await setAutonomous(userId, input);
      expect((await (await collections.bots()).findOne({ userId }))!.status).toBe("ACTIVE");
      expect((await (await collections.tradingSettings()).findOne({ userId }))!.environment).toBe("LIVE");
      await setAutonomous(userId, { ...input, enabled: false });
      expect((await (await collections.bots()).findOne({ userId }))!.status).toBe("PAUSED");
      expect((await (await collections.tradingSettings()).findOne({ userId }))!.autonomous!.enabled).toBe(false);
    });
    it("says when Unattended is on but nothing is trading, because the other switches are separate: auto trading, the environment, the bot being started", async () => {
      const { setAutonomous, autonomousStatus } = await import("@/services/autonomous");
      const input = { enabled: true, dailyTargetUsd: 5, dailyLossLimitUsd: 3, givebackPct: 30, maxConsecutiveLosses: 3, cooldownMinutes: 30, entryMaxRangePct: 35, dayOffsetMinutes: 0 };
      await setAutonomous(userId, input);
      expect(await autonomousStatus(userId)).toMatchObject({ running: true, blockedBy: null });
      const settings = await collections.tradingSettings();
      await settings.updateOne({ userId }, { $set: { autoTradingEnabled: false } }); // switched off in Trading settings afterwards
      expect((await autonomousStatus(userId)).blockedBy).toMatch(/auto trading is off/);
      await settings.updateOne({ userId }, { $set: { autoTradingEnabled: true } });
      await (await collections.bots()).updateOne({ userId }, { $set: { status: "PAUSED" } });
      expect(await autonomousStatus(userId)).toMatchObject({ running: false, blockedBy: expect.stringMatching(/bot is paused/) });
      await setAutonomous(userId, { ...input, enabled: false });
      expect((await autonomousStatus(userId)).blockedBy).toBeNull(); // off is not "blocked"
    });
    it("on without a bot wallet is refused", async () => {
      const { setAutonomous } = await import("@/services/autonomous");
      const other = newId();
      await expect(setAutonomous(other, { enabled: true, dailyTargetUsd: 5, dailyLossLimitUsd: 3, givebackPct: 30, maxConsecutiveLosses: 3, cooldownMinutes: 30, entryMaxRangePct: 35, dayOffsetMinutes: 0 })).rejects.toMatchObject({ status: 409 });
      await (await collections.tradingSettings()).deleteMany({ userId: other });
    });
  });
});
