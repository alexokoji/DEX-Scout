import { z } from "zod";
import { CHAIN_IDS, CHAINS, normalizeAddress } from "@/core/chains";
import { FEES } from "@/core/config";
import { providers } from "@/core/providers/registry";
import { checkManualAmount, type CapitalState } from "@/core/trading/capital";
import { applySell, deriveStatus } from "@/core/trading/positions";
import { entryWarnings, validateEntry, validateSlippage, type TradeCandidate } from "@/core/trading/validation";
import type { Analysis, ChainId, ProfitTargetConfig, SwapQuote } from "@/core/types";
import { collections, newId, withId, withUserLock, type ClientSession } from "@/lib/db";
import { liveTradingAllowed } from "@/lib/env";
import { logEvent, safeMessage } from "@/lib/events";
import type { Environment, Json, TokenDoc, TradeDoc, TradeKind } from "@/lib/models";
import { analyzeSnapshot, loadAnalysis, persistAnalysis } from "./analysis";
import { getSettings, type UserSettings } from "./settings";
import { notifyUser } from "./notifications";
import { spendableUsd } from "./walletBalance";

export class TradeError extends Error {
  constructor(message: string, public status = 400, public violations: string[] = []) {
    super(message);
  }
}

/** Client-supplied trade intent. Only these fields are accepted; prices/limits are re-derived server-side. */
export const prepareTradeInput = z.object({
  chain: z.enum(CHAIN_IDS),
  tokenAddress: z.string().min(32).max(44),
  amountUsd: z.number().positive().max(1_000_000),
  slippageBps: z.number().int().min(1).max(5000),
  priorityFeeNative: z.number().min(0).max(1).optional(),
  environment: z.literal("LIVE"),
  signalId: z.string().optional(),
});
export type PrepareTradeInput = z.infer<typeof prepareTradeInput>;

const PREPARED_TTL_MS = 60_000;
// A trade the BOT queued waits for the user to come and approve it, so it gets a real approval window. Staleness is
// handled by refreshPreparedTrade (a fresh quote + transaction is built the moment the user clicks), not by a short TTL.
const APPROVAL_TTL_MS = 15 * 60_000;
// After refreshing, the user is about to sign; keep the window comfortably longer than a wallet prompt.
const REFRESHED_TTL_MS = 5 * 60_000;
// A signature for a trade that lapsed while the wallet prompt was open must still be recorded (see executeTrade).
const LATE_SIGNATURE_GRACE_MS = 30 * 60_000;

export async function getOrCreateAccount(userId: string, environment: Environment, session?: ClientSession) {
  const col = await collections.tradingAccounts();
  await col.updateOne(
    { userId, environment },
    { $setOnInsert: { _id: newId(), userId, environment, realizedPnlUsd: 0, createdAt: new Date() } },
    { upsert: true, session },
  );
  const acct = await col.findOne({ userId, environment }, { session });
  if (!acct) throw new Error("Trading account disappeared right after creation");
  return withId(acct);
}

/** Open exposure, plus — when `chain` is given — what the user's wallet can spend on that chain (null if unknown). */
export async function capitalState(userId: string, environment: Environment, session?: ClientSession, chain?: ChainId): Promise<CapitalState> {
  const positions = await collections.positions();
  const open = await positions.find({ userId, environment, status: { $ne: "CLOSED" } }, { projection: { costBasisUsd: 1 }, session }).toArray();
  const walletUsd = chain ? await spendableUsd(userId, chain).catch(() => null) : undefined;
  return { deployedUsd: open.reduce((s, p) => s + p.costBasisUsd, 0), openPositions: open.length, walletUsd };
}

function quoteJson(q: SwapQuote): Json {
  return { ...q, raw: q.raw ?? null } as unknown as Json;
}

async function getToken(id: string, session?: ClientSession): Promise<TokenDoc> {
  const tokens = await collections.tokens();
  const t = await tokens.findOne({ _id: id }, { session });
  if (!t) throw new TradeError("Token not found or no longer tracked", 404);
  return t;
}

/** Fresh analysis for a token, re-computed on demand if the stored one is missing/stale. */
export async function ensureAnalysis(token: { id: string; address: string; chain: string }, maxAgeMs = 2 * 60_000): Promise<Analysis> {
  const cached = await loadAnalysis(token.id);
  if (cached && Date.now() - cached.computedAt.getTime() < maxAgeMs) return cached;
  const p = providers();
  const chain = token.chain as ChainId;
  const snap = await p.data.getSnapshot(chain, token.address);
  if (!snap) throw new TradeError("Token not found or no longer tradeable", 404);
  const raw = await p.data.getOnChain(chain, token.address, snap);
  const a = await analyzeSnapshot(snap, raw);
  await persistAnalysis(token.id, a);
  return a;
}

function assertEnvironment(env: Environment) {
  if (env === "LIVE" && !liveTradingAllowed()) {
    throw new TradeError("LIVE trading is disabled. Set LIVE_TRADING_ENABLED=true with real providers to enable it.", 403);
  }
}

/** Wallet records are per address family: one EVM address works on every EVM chain. */
export const walletFamily = (chain: string) => (CHAINS[chain as ChainId]?.family === "evm" ? "evm" : "solana");

async function liveWallet(userId: string, chain: string) {
  const wallets = await collections.wallets();
  const w = await wallets.findOne({ userId, chain: walletFamily(chain) }, { sort: { createdAt: -1 } });
  if (!w) throw new TradeError(`Connect and verify a ${walletFamily(chain) === "evm" ? "EVM" : "Solana"} wallet before trading LIVE on ${CHAINS[chain as ChainId]?.name ?? chain}`, 400);
  return withId(w);
}

async function findTokenOrThrow(chain: string, address: string): Promise<TokenDoc> {
  const tokens = await collections.tokens();
  const t = await tokens.findOne({ chain, address: normalizeAddress(chain as ChainId, address) });
  if (!t) throw new TradeError("Unknown token", 404);
  return t;
}

/** Non-persisting quote + eligibility check used by the trading panel for live feedback. */
export async function quoteTrade(userId: string, input: PrepareTradeInput, automatic = false) {
  assertEnvironment(input.environment);
  const settings = await getSettings(userId);
  const token = await findTokenOrThrow(input.chain, input.tokenAddress);
  const p = providers();
  let quote: SwapQuote;
  try {
    quote = await p.dex.getQuote({ chain: input.chain, side: "BUY", tokenAddress: token.address, amountUsd: input.amountUsd, slippageBps: input.slippageBps, priorityFeeNative: input.priorityFeeNative });
  } catch (err) {
    throw new TradeError(`Quote failed: ${safeMessage(err)}`, 502);
  }
  const analysis = await ensureAnalysis(withId(token));
  const sim = await p.dex.simulateSwap({ chain: input.chain, side: "SELL", tokenAddress: token.address, amountUsd: input.amountUsd, slippageBps: input.slippageBps });
  const state = await capitalState(userId, input.environment, undefined, input.chain);
  const candidate = toCandidate(analysis, quote, sim.ok);
  const violations = evaluateEntryRules(settings, state, input, candidate, automatic);
  // manual buys get the user's own preference thresholds as warnings; only the bot is blocked by them
  const warnings = automatic ? [] : entryWarnings(candidate, settings);
  return { quote, violations, warnings, analysis: { riskLevel: analysis.safety.riskLevel, warnings: analysis.safety.warnings, criticalIssues: analysis.safety.criticalIssues }, source: p.mock ? ("MOCK" as const) : ("LIVE" as const) };
}

function toCandidate(analysis: Analysis, quote: SwapQuote, sellSimOk: boolean): TradeCandidate {
  return {
    liquidityUsd: analysis.snapshot.liquidityUsd,
    volume24hUsd: analysis.snapshot.volume24h,
    opportunityScore: analysis.opportunity.score,
    safety: analysis.safety,
    quote,
    sellSimulationOk: sellSimOk && analysis.onchainRaw.sellSimulationOk,
  };
}

function evaluateEntryRules(
  settings: UserSettings,
  state: CapitalState,
  input: PrepareTradeInput,
  candidate: TradeCandidate,
  automatic: boolean,
): string[] {
  const v: string[] = [];
  const slipErr = validateSlippage(input.slippageBps, settings.maxSlippageBps);
  if (slipErr) v.push(slipErr);
  const capErr = checkManualAmount(settings, state, input.amountUsd);
  if (capErr) v.push(capErr);
  v.push(...validateEntry(candidate, settings, { automatic }));
  return v;
}

/** Create a PREPARED trade after full server-side validation. Nothing is executed or signed here. */
export async function prepareTrade(userId: string, input: PrepareTradeInput, kind: TradeKind = "MANUAL_ENTRY") {
  const { quote, violations, analysis } = await quoteTrade(userId, input, kind === "AUTO_ENTRY");
  if (violations.length) throw new TradeError("Trade rejected by validation", 422, violations);
  const token = await findTokenOrThrow(input.chain, input.tokenAddress);
  const account = await getOrCreateAccount(userId, input.environment);

  let unsigned: string | null = null;
  if (input.environment === "LIVE") {
    const wallet = await liveWallet(userId, input.chain);
    try {
      unsigned = (await providers().dex.buildSwapTransaction(quote, wallet.address)).unsignedTxBase64;
    } catch (err) {
      throw new TradeError(`Could not build transaction: ${safeMessage(err)}`, 502);
    }
  }

  const tradeId = newId();
  const trades = await collections.trades();
  const doc: TradeDoc = {
    _id: tradeId,
    userId,
    accountId: account.id,
    tokenId: token._id,
    positionId: null,
    side: "BUY",
    kind,
    environment: input.environment,
    dataSource: quote.source,
    status: "PREPARED",
    inputUsd: input.amountUsd,
    tokenAmount: quote.outputAmount,
    priceUsd: quote.effectivePriceUsd,
    priceImpactPct: quote.priceImpactPct,
    slippageBps: input.slippageBps,
    feesUsd: quote.platformFeeUsd,
    networkFeeUsd: quote.networkFeeUsd + quote.priorityFeeUsd,
    realizedPnlUsd: null,
    quote: { ...(quoteJson(quote) as object), signalId: input.signalId ?? null } as Json,
    failureReason: null,
    expiresAt: new Date(Date.now() + (kind === "AUTO_ENTRY" ? APPROVAL_TTL_MS : PREPARED_TTL_MS)),
    createdAt: new Date(),
    executedAt: null,
    transaction: unsigned ? { chain: input.chain, signature: null, status: "PENDING", unsignedTx: unsigned, error: null, slot: null, submittedAt: null, confirmedAt: null, createdAt: new Date() } : null,
  };
  await trades.insertOne(doc);
  await logEvent({ type: "TRADE_REQUESTED", source: "trading", userId, message: `${input.environment} buy of $${input.amountUsd} ${token.symbol} prepared`, data: { tradeId } });
  return { trade: withId(doc), quote, analysis, unsignedTxBase64: unsigned };
}

/**
 * Execute a PREPARED trade. The user's wallet has already signed & broadcast; we record the signature
 * and confirm it on-chain. The request body never contains prices or amounts — everything is taken from
 * the stored, validated Trade.
 */
export async function executeTrade(userId: string, tradeId: string, opts: { signature?: string } = {}) {
  const trades = await collections.trades();
  const trade = await trades.findOne({ _id: tradeId, userId });
  if (!trade) throw new TradeError("Trade not found", 404);
  // A LIVE signature means the user's wallet ALREADY broadcast the transaction: it is on-chain and cannot be undone.
  // Refusing to record it because our quote's TTL lapsed (or the bot cycle flipped the trade to EXPIRED) while the
  // wallet prompt was open would leave a real, untracked position. So a signature is always recorded (within a
  // grace window); reconcileLiveTrade still verifies the signer and the token movement on-chain before trusting it.
  const lateSignature = trade.environment === "LIVE" && !!opts.signature && Date.now() - trade.createdAt.getTime() < LATE_SIGNATURE_GRACE_MS;
  if (trade.status !== "PREPARED" && !(lateSignature && trade.status === "EXPIRED")) throw new TradeError(`Trade is ${trade.status}, not executable`, 409);
  if (!lateSignature && trade.expiresAt && trade.expiresAt.getTime() < Date.now()) {
    await trades.updateOne({ _id: trade._id }, { $set: { status: "EXPIRED" } });
    throw new TradeError("Quote expired — request a new quote", 410);
  }
  assertEnvironment(trade.environment);
  return recordLiveSignature(userId, trade, opts.signature);
}

/**
 * Rebuilds a queued trade's quote and UNSIGNED transaction right before the user signs it. A trade the bot queued
 * minutes ago carries a stale quote and (on Solana) a stale blockhash, which wallets refuse or fail to simulate —
 * that is why "Review & sign" could fail to open the wallet. Limits are re-validated against current conditions
 * (hard safety limits only: the user is approving this one by hand), so a token that has since turned bad is
 * refused instead of signed blind. Never signs or sends anything.
 */
export async function refreshPreparedTrade(userId: string, tradeId: string) {
  assertEnvironment("LIVE");
  const trades = await collections.trades();
  const trade = await trades.findOne({ _id: tradeId, userId });
  if (!trade) throw new TradeError("Trade not found", 404);
  const recoverable = trade.status === "PREPARED" || (trade.status === "EXPIRED" && Date.now() - trade.createdAt.getTime() < LATE_SIGNATURE_GRACE_MS);
  if (trade.environment !== "LIVE" || !recoverable || trade.transaction?.signature) throw new TradeError(`Trade is ${trade.status}; it can no longer be refreshed`, 409);

  const token = await getToken(trade.tokenId);
  const chain = token.chain as ChainId;
  const wallet = await liveWallet(userId, token.chain);
  const p = providers();

  let quote: SwapQuote;
  if (trade.side === "BUY") {
    const q = await quoteTrade(userId, { chain, tokenAddress: token.address, amountUsd: trade.inputUsd, slippageBps: trade.slippageBps, environment: "LIVE" }, false);
    if (q.violations.length) throw new TradeError("Trade no longer passes validation", 422, q.violations);
    quote = q.quote;
  } else {
    try {
      quote = await p.dex.getQuote({ chain, side: "SELL", tokenAddress: token.address, amountUsd: trade.inputUsd, tokenAmount: trade.tokenAmount, slippageBps: trade.slippageBps });
    } catch (err) {
      throw new TradeError(`Quote failed: ${safeMessage(err)}`, 502);
    }
  }
  let unsigned: string;
  try {
    unsigned = (await p.dex.buildSwapTransaction(quote, wallet.address)).unsignedTxBase64;
  } catch (err) {
    throw new TradeError(`Could not build transaction: ${safeMessage(err)}`, 502);
  }

  const prev = (trade.quote ?? {}) as { signalId?: string | null; reason?: string; targetLevel?: number | null };
  const expiresAt = new Date(Date.now() + REFRESHED_TTL_MS);
  await trades.updateOne(
    { _id: trade._id },
    {
      $set: {
        status: "PREPARED",
        expiresAt,
        ...(trade.side === "BUY" ? { tokenAmount: quote.outputAmount } : {}),
        priceUsd: quote.effectivePriceUsd,
        priceImpactPct: quote.priceImpactPct,
        feesUsd: quote.platformFeeUsd,
        networkFeeUsd: quote.networkFeeUsd + quote.priorityFeeUsd,
        quote: { ...(quoteJson(quote) as object), signalId: prev.signalId ?? null, ...(prev.reason ? { reason: prev.reason } : {}), ...(prev.targetLevel !== undefined ? { targetLevel: prev.targetLevel } : {}) } as Json,
        "transaction.unsignedTx": unsigned,
      },
    },
  );
  return { tradeId: trade._id, unsignedTxBase64: unsigned, expiresAt, priceImpactPct: quote.priceImpactPct, side: trade.side, chain };
}

// ───────────────────────────── LIVE ─────────────────────────────

const SOLANA_SIGNATURE = /^[1-9A-HJ-NP-Za-km-z]{64,90}$/;
const EVM_TX_HASH = /^0x[0-9a-fA-F]{64}$/;

function isValidSignature(chain: string, signature: string): boolean {
  return CHAINS[chain as ChainId]?.family === "evm" ? EVM_TX_HASH.test(signature) : SOLANA_SIGNATURE.test(signature);
}

/**
 * LIVE: the browser wallet signed and broadcast the prepared (unsigned) transaction. We never hold keys and never
 * broadcast on the user's behalf; we only record the signature and follow it to confirmation on-chain.
 */
async function recordLiveSignature(userId: string, trade: TradeDoc, signature?: string) {
  const chain = trade.transaction?.chain;
  if (!signature || !chain || !isValidSignature(chain, signature)) throw new TradeError("A valid transaction signature is required for LIVE trades", 400);
  const trades = await collections.trades();
  await trades.updateOne(
    { _id: trade._id },
    { $set: { status: "PENDING", "transaction.signature": signature, "transaction.status": "PENDING", "transaction.submittedAt": new Date() } },
  );
  await logEvent({ type: "TRADE_EXECUTED", source: "live", userId, message: "LIVE trade submitted by wallet; awaiting confirmation", data: { tradeId: trade._id, signature } });
  return reconcileLiveTrade(trade._id);
}

/** Poll the chain for a PENDING live trade; create/adjust the Position when confirmed. Safe to call repeatedly. */
export async function reconcileLiveTrade(tradeId: string) {
  const trades = await collections.trades();
  const trade = await trades.findOne({ _id: tradeId });
  if (!trade || trade.status !== "PENDING" || !trade.transaction?.signature) return { ok: false as const, status: trade?.status ?? "MISSING" };
  const token = await getToken(trade.tokenId);
  const tChain = token.chain as ChainId;
  const st = await providers().dex.getTransactionStatus(tChain, trade.transaction.signature);
  if (st.status === "PENDING" || st.status === "NOT_FOUND") {
    // give up on transactions never seen on-chain after 3 minutes
    if (st.status === "NOT_FOUND" && trade.transaction.submittedAt && Date.now() - trade.transaction.submittedAt.getTime() > 180_000) {
      await trades.updateOne({ _id: tradeId }, { $set: { status: "FAILED", failureReason: "Transaction not found on-chain (dropped or timed out)", "transaction.status": "FAILED", "transaction.error": "timeout" } });
      await logEvent({ type: "TRADE_FAILED", source: "live", userId: trade.userId, level: "WARN", message: `LIVE trade for ${token.symbol} timed out`, data: { tradeId } });
      return { ok: false as const, status: "FAILED" as const };
    }
    return { ok: false as const, status: "PENDING" as const };
  }
  if (st.status === "FAILED") {
    await trades.updateOne({ _id: tradeId }, { $set: { status: "FAILED", failureReason: (st.error ?? "Transaction failed on-chain").slice(0, 300), "transaction.status": "FAILED", "transaction.error": st.error ?? "failed", "transaction.slot": st.slot ?? null } });
    await logEvent({ type: "TRADE_FAILED", source: "live", userId: trade.userId, level: "WARN", message: `LIVE trade for ${token.symbol} failed on-chain`, data: { tradeId, error: st.error } });
    return { ok: false as const, status: "FAILED" as const };
  }

  // CONFIRMED: verify the signer and use real on-chain amounts where the adapter can inspect the transaction
  const dex = providers().dex;
  const wallets = await collections.wallets();
  const wallet = await wallets.findOne({ userId: trade.userId, chain: walletFamily(token.chain) }, { sort: { createdAt: -1 } });
  const insp = dex.inspectTransaction && wallet ? await dex.inspectTransaction(tChain, trade.transaction.signature, wallet.address, token.address).catch(() => null) : null;
  const sameAddr = (a: string, b: string) => normalizeAddress(tChain, a) === normalizeAddress(tChain, b);
  // The signature must come from the linked wallet AND actually move the expected token in the expected direction
  // (buy: tokens received, sell: tokens sent). Anything else is not the swap we prepared.
  const mismatch = !insp || !wallet
    ? null
    : !sameAddr(insp.signer, wallet.address)
      ? "Transaction was not signed by your linked wallet"
      : trade.side === "BUY" && insp.tokenDelta <= 0
        ? "Transaction did not deliver the expected token"
        : trade.side === "SELL" && insp.tokenDelta >= 0
          ? "Transaction did not sell the expected token"
          : null;
  if (mismatch) {
    await trades.updateOne({ _id: tradeId }, { $set: { status: "FAILED", failureReason: mismatch, "transaction.status": "FAILED", "transaction.error": mismatch } });
    await logEvent({ type: "TRADE_FAILED", source: "live", userId: trade.userId, level: "ERROR", message: `LIVE trade ${tradeId}: ${mismatch}; position not changed`, data: { tradeId } });
    return { ok: false as const, status: "FAILED" as const };
  }
  const nativeUsdNow = insp && insp.nativeDelta !== 0 ? await providers().chains[tChain].nativeUsdPrice().catch(() => 0) : 0;
  const realTokens = insp ? Math.abs(insp.tokenDelta) : 0;
  const tokenAmountActual = realTokens > 0 ? realTokens : trade.tokenAmount;
  const buyCostUsd = insp && nativeUsdNow > 0 ? Math.abs(insp.nativeDelta) * nativeUsdNow : trade.inputUsd + trade.networkFeeUsd;
  const sellProceedsUsd = insp && nativeUsdNow > 0 ? Math.max(0, insp.nativeDelta) * nativeUsdNow : trade.inputUsd - trade.feesUsd - trade.networkFeeUsd;

  const positions = await collections.positions();
  const positionEvents = await collections.positionEvents();
  const tradingAccounts = await collections.tradingAccounts();

  await withUserLock(trade.userId, async (session) => {
    const settings = await getSettings(trade.userId);
    const now = new Date();
    await trades.updateOne({ _id: tradeId }, { $set: { "transaction.status": "CONFIRMED", "transaction.confirmedAt": now, "transaction.slot": st.slot ?? null } }, { session });
    if (trade.side === "BUY") {
      const positionId = newId();
      const signalId = (trade.quote as { signalId?: string | null } | null)?.signalId ?? null;
      await positions.insertOne(
        {
          _id: positionId, userId: trade.userId, accountId: trade.accountId, tokenId: trade.tokenId, environment: "LIVE", status: "OPEN", health: "HOLD",
          healthNotes: { entryLiquidityUsd: token.liquidityUsd },
          origin: trade.kind === "AUTO_ENTRY" ? "AUTO" : "MANUAL",
          sourceSignalId: signalId,
          entryPriceUsd: buyCostUsd / tokenAmountActual, currentPriceUsd: token.priceUsd, initialAmount: tokenAmountActual, amount: tokenAmountActual,
          investedUsd: buyCostUsd, costBasisUsd: buyCostUsd, realizedPnlUsd: 0, targetsHit: 0,
          targetsSnapshot: settings.targets, emergencyEnabled: settings.emergencyEnabled, emergencyAutoExit: settings.emergencyAutoExit,
          openedAt: now, updatedAt: now, closedAt: null, lastAnalysisAt: null,
        },
        { session },
      );
      await positionEvents.insertOne({ _id: newId(), positionId, type: "OPENED", message: "LIVE entry confirmed on-chain", data: { tradeId }, createdAt: now }, { session });
      await trades.updateOne({ _id: tradeId }, { $set: { status: "CONFIRMED", positionId, executedAt: now } }, { session });
      if (signalId) {
        const signals = await collections.signals();
        await signals.updateOne({ _id: signalId, status: "ACTIVE" }, { $set: { status: "CONSUMED", updatedAt: now } }, { session }).catch(() => {});
      }
      await logEvent({ type: "POSITION_OPENED", source: "live", userId: trade.userId, message: `LIVE position opened: ${token.symbol}`, data: { positionId } });
    } else if (trade.positionId) {
      const pos = await positions.findOne({ _id: trade.positionId }, { session });
      if (!pos) throw new Error(`Position ${trade.positionId} not found while confirming LIVE sell`);
      const res = applySell(
        { entryPriceUsd: pos.entryPriceUsd, initialAmount: pos.initialAmount, amount: pos.amount, costBasisUsd: pos.costBasisUsd, targetsHit: pos.targetsHit, realizedPnlUsd: pos.realizedPnlUsd },
        tokenAmountActual,
        sellProceedsUsd,
      );
      const level = (trade.quote as { targetLevel?: number } | null)?.targetLevel;
      const targetsHit = level ? Math.max(pos.targetsHit, level) : pos.targetsHit;
      await positions.updateOne(
        { _id: pos._id },
        {
          $set: {
            amount: res.amount, costBasisUsd: res.costBasisUsd, realizedPnlUsd: res.realizedPnlUsd, targetsHit, updatedAt: now, closedAt: res.closed ? now : null,
            status: deriveStatus({ closed: res.closed, emergency: trade.kind === "EMERGENCY_EXIT" && !res.closed, targetsHit, unrealizedPnlUsd: res.amount * pos.currentPriceUsd - res.costBasisUsd }),
          },
        },
        { session },
      );
      await trades.updateOne({ _id: tradeId }, { $set: { status: "CONFIRMED", executedAt: now, realizedPnlUsd: res.realizedDeltaUsd } }, { session });
      await tradingAccounts.updateOne({ _id: trade.accountId }, { $inc: { realizedPnlUsd: res.realizedDeltaUsd } }, { session });
      await positionEvents.insertOne({ _id: newId(), positionId: pos._id, type: "LIVE_SELL", message: "LIVE sell confirmed on-chain", data: { tradeId }, createdAt: now }, { session });
      if (res.closed) await logEvent({ type: "POSITION_CLOSED", source: "live", userId: trade.userId, message: `LIVE position closed: ${token.symbol}`, data: { positionId: pos._id } });
    }
  });
  await logEvent({ type: "TRADE_EXECUTED", source: "live", userId: trade.userId, message: `LIVE ${trade.side} ${token.symbol} confirmed`, data: { tradeId } });
  return { ok: true as const, status: "CONFIRMED" as const };
}

/** Prepare an unsigned LIVE sell that waits in the user's approval queue (no keys are held server-side). */
/** Wording for the "a sell is waiting for your signature" notification. */
export function sellQueuedNotification(kind: TradeKind, symbol: string, chainName: string, reason: string, fraction: number, usdValue: number, tradeId: string, positionId = "") {
  const pct = Math.round(Math.min(1, Math.max(0, fraction)) * 100);
  const title = kind === "EMERGENCY_EXIT" ? `Emergency exit ready: ${symbol}` : kind === "TARGET_EXIT" ? `Target hit: ${symbol} sell ready to sign` : `Sell ready to sign: ${symbol}`;
  return {
    type: "SELL_QUEUED" as const,
    title,
    body: `${reason}. Sell ${pct}% (~$${usdValue.toFixed(2)}) on ${chainName}. Open DEX Scout and approve it in your wallet within 10 minutes.`,
    url: "/wallet",
    tradeId,
    dedupeKey: `sell:${positionId}:${kind}`,
  };
}

export async function prepareLiveSell(userId: string, positionId: string, sellAmount: number, kind: TradeKind, reason: string, targetLevel?: number) {
  assertEnvironment("LIVE");
  const positions = await collections.positions();
  const trades = await collections.trades();
  const pos = await positions.findOne({ _id: positionId, userId, environment: "LIVE" });
  if (!pos) throw new TradeError("Position not found", 404);
  const dup = await trades.findOne({ positionId, side: "SELL", kind, status: "PREPARED", expiresAt: { $gt: new Date() } });
  if (dup) return { trade: withId(dup), created: false as const };
  const token = await getToken(pos.tokenId);
  const wallet = await liveWallet(userId, token.chain);
  const settings = await getSettings(userId);
  const amount = Math.min(sellAmount, pos.amount);
  const p = providers();
  const quote = await p.dex.getQuote({ chain: token.chain as ChainId, side: "SELL", tokenAddress: token.address, amountUsd: amount * token.priceUsd, tokenAmount: amount, slippageBps: kind === "EMERGENCY_EXIT" ? 2000 : settings.maxSlippageBps });
  const { unsignedTxBase64 } = await p.dex.buildSwapTransaction(quote, wallet.address);
  const tradeId = newId();
  const now = new Date();
  const doc: TradeDoc = {
    _id: tradeId, userId, accountId: pos.accountId, tokenId: pos.tokenId, positionId: pos._id, side: "SELL", kind, environment: "LIVE", dataSource: quote.source, status: "PREPARED",
    inputUsd: amount * token.priceUsd, tokenAmount: amount, priceUsd: quote.effectivePriceUsd, priceImpactPct: quote.priceImpactPct, slippageBps: quote.slippageBps,
    feesUsd: quote.platformFeeUsd, networkFeeUsd: quote.networkFeeUsd + quote.priorityFeeUsd, realizedPnlUsd: null,
    quote: { ...(quoteJson(quote) as object), reason, targetLevel: targetLevel ?? null } as Json,
    failureReason: null, expiresAt: new Date(Date.now() + 10 * 60_000), createdAt: now, executedAt: null,
    transaction: { chain: token.chain, signature: null, status: "PENDING", unsignedTx: unsignedTxBase64, error: null, slot: null, submittedAt: null, confirmedAt: null, createdAt: now },
  };
  await trades.insertOne(doc);
  await logEvent({ type: "TRADE_REQUESTED", source: "live", userId, message: `LIVE ${kind} for ${token.symbol} awaiting wallet approval: ${reason}`, data: { tradeId } });
  // The bot can't sign, so a queued sell does nothing until the user approves it: tell them it's waiting.
  await notifyUser(userId, sellQueuedNotification(kind, token.symbol, CHAINS[token.chain as ChainId]?.name ?? token.chain, reason, amount / pos.amount, doc.inputUsd, tradeId, pos._id));
  return { trade: withId(doc), created: true as const };
}

export const FEE_DEFAULTS = FEES;
export type { ProfitTargetConfig };
