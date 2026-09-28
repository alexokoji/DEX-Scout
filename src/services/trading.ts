import { z } from "zod";
import { CHAIN_IDS, CHAINS, normalizeAddress } from "@/core/chains";
import { FEES } from "@/core/config";
import { providers } from "@/core/providers/registry";
import { checkManualAmount, type CapitalState } from "@/core/trading/capital";
import { simulateFill } from "@/core/trading/paperBroker";
import { applySell, deriveStatus } from "@/core/trading/positions";
import { validateEntry, validateSlippage } from "@/core/trading/validation";
import type { Analysis, ChainId, ProfitTargetConfig, SwapQuote } from "@/core/types";
import { collections, newId, withId, withUserLock, type ClientSession } from "@/lib/db";
import { liveTradingAllowed } from "@/lib/env";
import { logEvent, safeMessage } from "@/lib/events";
import type { Environment, Json, TokenDoc, TradeDoc, TradeKind } from "@/lib/models";
import { analyzeSnapshot, loadAnalysis, persistAnalysis } from "./analysis";
import { getSettings, type UserSettings } from "./settings";

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
  environment: z.enum(["PAPER", "LIVE"]),
  signalId: z.string().optional(),
});
export type PrepareTradeInput = z.infer<typeof prepareTradeInput>;

const PREPARED_TTL_MS = 60_000;

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

export async function capitalState(userId: string, environment: Environment, session?: ClientSession): Promise<CapitalState> {
  const positions = await collections.positions();
  const open = await positions.find({ userId, environment, status: { $ne: "CLOSED" } }, { projection: { costBasisUsd: 1 }, session }).toArray();
  return { deployedUsd: open.reduce((s, p) => s + p.costBasisUsd, 0), openPositions: open.length };
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
  const state = await capitalState(userId, input.environment);
  const violations = evaluateEntryRules(settings, state, input, analysis, quote, sim.ok, automatic);
  return { quote, violations, analysis: { riskLevel: analysis.safety.riskLevel, warnings: analysis.safety.warnings, criticalIssues: analysis.safety.criticalIssues }, source: p.mock ? ("MOCK" as const) : ("LIVE" as const) };
}

function evaluateEntryRules(
  settings: UserSettings,
  state: CapitalState,
  input: PrepareTradeInput,
  analysis: Analysis,
  quote: SwapQuote,
  sellSimOk: boolean,
  automatic: boolean,
): string[] {
  const v: string[] = [];
  const slipErr = validateSlippage(input.slippageBps, settings.maxSlippageBps);
  if (slipErr) v.push(slipErr);
  const capErr = checkManualAmount(settings, state, input.amountUsd);
  if (capErr) v.push(capErr);
  v.push(
    ...validateEntry(
      {
        liquidityUsd: analysis.snapshot.liquidityUsd,
        volume24hUsd: analysis.snapshot.volume24h,
        opportunityScore: analysis.opportunity.score,
        safety: analysis.safety,
        quote,
        sellSimulationOk: sellSimOk && analysis.onchainRaw.sellSimulationOk,
      },
      settings,
      { automatic },
    ),
  );
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
    expiresAt: new Date(Date.now() + PREPARED_TTL_MS),
    createdAt: new Date(),
    executedAt: null,
    transaction: unsigned ? { chain: input.chain, signature: null, status: "PENDING", unsignedTx: unsigned, error: null, slot: null, submittedAt: null, confirmedAt: null, createdAt: new Date() } : null,
  };
  await trades.insertOne(doc);
  await logEvent({ type: "TRADE_REQUESTED", source: "trading", userId, message: `${input.environment} buy of $${input.amountUsd} ${token.symbol} prepared`, data: { tradeId } });
  return { trade: withId(doc), quote, analysis, unsignedTxBase64: unsigned };
}

/**
 * Execute a PREPARED trade.
 *  - PAPER: simulated fill; a Position is created only if the simulated fill succeeds.
 *  - LIVE:  the user's wallet has already signed & broadcast; we record the signature and confirm it on-chain.
 * The request body never contains prices or amounts — everything is taken from the stored, validated Trade.
 */
export async function executeTrade(userId: string, tradeId: string, opts: { signature?: string } = {}) {
  const trades = await collections.trades();
  const trade = await trades.findOne({ _id: tradeId, userId });
  if (!trade) throw new TradeError("Trade not found", 404);
  if (trade.status !== "PREPARED") throw new TradeError(`Trade is ${trade.status}, not executable`, 409);
  if (trade.expiresAt && trade.expiresAt.getTime() < Date.now()) {
    await trades.updateOne({ _id: trade._id }, { $set: { status: "EXPIRED" } });
    throw new TradeError("Quote expired — request a new quote", 410);
  }
  assertEnvironment(trade.environment);

  if (trade.environment === "LIVE") return recordLiveSignature(userId, trade, opts.signature);
  return trade.side === "BUY" ? executePaperBuy(userId, trade._id) : executePaperSellTrade(trade._id);
}

// ───────────────────────────── PAPER ─────────────────────────────

async function executePaperBuy(userId: string, tradeId: string) {
  const p = providers();
  const settings = await getSettings(userId);
  const trades = await collections.trades();
  const positions = await collections.positions();
  const positionEvents = await collections.positionEvents();
  const signals = await collections.signals();

  const trade0 = await trades.findOne({ _id: tradeId });
  if (!trade0) throw new TradeError("Trade not found", 404);
  const token0 = await getToken(trade0.tokenId);
  const chain0 = token0.chain as ChainId;
  const snap = await p.data.getSnapshot(chain0, token0.address);
  const raw = snap ? await p.data.getOnChain(chain0, token0.address, snap) : null;

  return withUserLock(userId, async (session) => {
    const trade = await trades.findOne({ _id: tradeId }, { session });
    if (!trade || trade.status !== "PREPARED") throw new TradeError("Trade already processed", 409);

    const state = await capitalState(userId, "PAPER", session);
    const capErr = checkManualAmount(settings, state, trade.inputUsd);
    // auto entries were already allocated by the bot; re-check hard limits for every entry regardless of origin
    if (capErr && !(trade.kind === "AUTO_ENTRY" && capErr.startsWith("Amount is below"))) {
      await trades.updateOne({ _id: tradeId }, { $set: { status: "FAILED", failureReason: capErr } }, { session });
      throw new TradeError(capErr, 422, [capErr]);
    }
    if (!snap || !raw) {
      await trades.updateOne({ _id: tradeId }, { $set: { status: "FAILED", failureReason: "Token no longer tradeable" } }, { session });
      throw new TradeError("Token no longer tradeable", 410);
    }
    const fill = simulateFill({
      chain: chain0,
      side: "BUY",
      amountUsd: trade.inputUsd,
      midPriceUsd: snap.priceUsd,
      liquidityUsd: snap.liquidityUsd,
      slippageBps: trade.slippageBps,
      tradeable: raw.poolActive && raw.sellSimulationOk,
    });
    if (!fill.ok) {
      await trades.updateOne({ _id: tradeId }, { $set: { status: "FAILED", failureReason: fill.reason } }, { session });
      await logEvent({ type: "TRADE_FAILED", source: "paper", userId, level: "WARN", message: `Paper buy of ${token0.symbol} failed: ${fill.reason}`, data: { tradeId } });
      return { ok: false as const, reason: fill.reason, tradeId };
    }

    const now = new Date();
    const signalId = (trade.quote as { signalId?: string | null } | null)?.signalId ?? null;
    const positionId = newId();
    await positions.insertOne(
      {
        _id: positionId,
        userId,
        accountId: trade.accountId,
        tokenId: trade.tokenId,
        environment: "PAPER",
        status: "OPEN",
        health: "HOLD",
        healthNotes: { entryLiquidityUsd: snap.liquidityUsd },
        origin: trade.kind === "AUTO_ENTRY" ? "AUTO" : "MANUAL",
        sourceSignalId: signalId,
        entryPriceUsd: fill.fillPriceUsd,
        currentPriceUsd: snap.priceUsd,
        initialAmount: fill.tokenAmount,
        amount: fill.tokenAmount,
        investedUsd: fill.usd,
        costBasisUsd: fill.usd,
        realizedPnlUsd: 0,
        targetsHit: 0,
        targetsSnapshot: settings.targets,
        emergencyEnabled: settings.emergencyEnabled,
        emergencyAutoExit: settings.emergencyAutoExit,
        openedAt: now,
        updatedAt: now,
        closedAt: null,
        lastAnalysisAt: null,
      },
      { session },
    );
    await positionEvents.insertOne({ _id: newId(), positionId, type: "OPENED", message: `Paper entry at $${fill.fillPriceUsd.toPrecision(5)} for $${fill.usd.toFixed(2)}`, data: { tradeId }, createdAt: now }, { session });
    await trades.updateOne(
      { _id: tradeId },
      { $set: { status: "CONFIRMED", positionId, tokenAmount: fill.tokenAmount, priceUsd: fill.fillPriceUsd, priceImpactPct: fill.priceImpactPct, feesUsd: fill.feesUsd, networkFeeUsd: fill.networkFeeUsd, executedAt: now } },
      { session },
    );
    if (signalId) await signals.updateOne({ _id: signalId, status: "ACTIVE" }, { $set: { status: "CONSUMED", updatedAt: now } }, { session }).catch(() => {});
    await logEvent({ type: "TRADE_EXECUTED", source: "paper", userId, message: `PAPER buy ${token0.symbol} $${fill.usd.toFixed(2)}`, data: { tradeId, positionId } });
    await logEvent({ type: "POSITION_OPENED", source: "paper", userId, message: `Position opened: ${token0.symbol} @ $${fill.fillPriceUsd.toPrecision(5)}`, data: { positionId } });
    return { ok: true as const, tradeId, positionId };
  });
}

/** Apply a PAPER sell to a position. Used by manual close, profit targets and emergency exits. */
export async function paperSell(
  userId: string,
  positionId: string,
  sellAmount: number,
  kind: TradeKind,
  reason: string,
  targetLevel?: number,
) {
  const p = providers();
  const positions = await collections.positions();
  const trades = await collections.trades();
  const positionEvents = await collections.positionEvents();
  const tradingAccounts = await collections.tradingAccounts();

  const position0 = await positions.findOne({ _id: positionId, userId, environment: "PAPER" });
  if (!position0) throw new TradeError("Position not found", 404);
  const token = await getToken(position0.tokenId);
  const chain1 = token.chain as ChainId;
  const snap = await p.data.getSnapshot(chain1, token.address);
  const raw = snap ? await p.data.getOnChain(chain1, token.address, snap) : null;
  const settings = await getSettings(userId);

  return withUserLock(userId, async (session) => {
    const pos = await positions.findOne({ _id: positionId }, { session });
    if (!pos) throw new TradeError("Position not found", 404);
    if (pos.status === "CLOSED" || pos.amount <= 0) throw new TradeError("Position already closed", 409);
    const amount = Math.min(sellAmount, pos.amount);
    const mid = snap?.priceUsd ?? pos.currentPriceUsd;
    const now = new Date();

    const fill = snap && raw
      ? simulateFill({
          chain: chain1,
          side: "SELL",
          amountUsd: amount * mid,
          midPriceUsd: mid,
          liquidityUsd: snap.liquidityUsd,
          slippageBps: kind === "EMERGENCY_EXIT" ? 2000 : settings.maxSlippageBps,
          tradeable: raw.poolActive && raw.sellSimulationOk,
          // exits may retry next tick; keep simulated random failures rarer than entries
          failureRate: 0.01,
        })
      : ({ ok: false, reason: "Token no longer tradeable" } as const);

    if (!fill.ok) {
      await trades.insertOne(
        {
          _id: newId(), userId, accountId: pos.accountId, tokenId: pos.tokenId, positionId: pos._id, side: "SELL", kind, environment: "PAPER", dataSource: "MOCK", status: "FAILED",
          inputUsd: amount * mid, tokenAmount: amount, priceUsd: mid, priceImpactPct: 0, slippageBps: settings.maxSlippageBps, feesUsd: 0, networkFeeUsd: 0, realizedPnlUsd: null,
          failureReason: fill.reason, quote: { reason } as Json, expiresAt: null, createdAt: now, executedAt: null, transaction: null,
        },
        { session },
      );
      await positionEvents.insertOne({ _id: newId(), positionId: pos._id, type: "SELL_FAILED", message: `Sell failed: ${fill.reason}`, data: null, createdAt: now }, { session });
      await logEvent({ type: "TRADE_FAILED", source: "paper", userId, level: "WARN", message: `Paper sell of ${token.symbol} failed: ${fill.reason}`, data: { positionId } });
      return { ok: false as const, reason: fill.reason };
    }

    const res = applySell(
      { entryPriceUsd: pos.entryPriceUsd, initialAmount: pos.initialAmount, amount: pos.amount, costBasisUsd: pos.costBasisUsd, targetsHit: pos.targetsHit, realizedPnlUsd: pos.realizedPnlUsd },
      amount,
      fill.usd,
    );
    const targetsHit = targetLevel ? Math.max(pos.targetsHit, targetLevel) : pos.targetsHit;
    const unrealized = res.amount * mid - res.costBasisUsd;
    const status = deriveStatus({ closed: res.closed, emergency: kind === "EMERGENCY_EXIT" && !res.closed, targetsHit, unrealizedPnlUsd: unrealized });

    const tradeId = newId();
    await trades.insertOne(
      {
        _id: tradeId, userId, accountId: pos.accountId, tokenId: pos.tokenId, positionId: pos._id, side: "SELL", kind, environment: "PAPER", dataSource: "MOCK", status: "CONFIRMED",
        inputUsd: amount * mid, tokenAmount: amount, priceUsd: fill.fillPriceUsd, priceImpactPct: fill.priceImpactPct, slippageBps: settings.maxSlippageBps,
        feesUsd: fill.feesUsd, networkFeeUsd: fill.networkFeeUsd, realizedPnlUsd: res.realizedDeltaUsd, quote: { reason } as Json, failureReason: null, expiresAt: null, createdAt: now, executedAt: now, transaction: null,
      },
      { session },
    );
    await positions.updateOne(
      { _id: pos._id },
      {
        $set: {
          amount: res.amount, costBasisUsd: res.costBasisUsd, realizedPnlUsd: res.realizedPnlUsd, targetsHit, status,
          currentPriceUsd: mid, updatedAt: now, closedAt: res.closed ? now : null,
          ...(kind === "EMERGENCY_EXIT" ? { health: "EMERGENCY" as const } : {}),
        },
      },
      { session },
    );
    await tradingAccounts.updateOne({ _id: pos.accountId }, { $inc: { realizedPnlUsd: res.realizedDeltaUsd } }, { session });
    await positionEvents.insertOne(
      {
        _id: newId(),
        positionId: pos._id,
        type: kind === "EMERGENCY_EXIT" ? "EMERGENCY_EXIT" : kind === "TARGET_EXIT" ? "PROFIT_TAKEN" : "MANUAL_EXIT",
        message: `${reason}: sold ${amount.toPrecision(6)} tokens @ $${fill.fillPriceUsd.toPrecision(5)} (P/L ${res.realizedDeltaUsd >= 0 ? "+" : ""}$${res.realizedDeltaUsd.toFixed(2)})`,
        data: { tradeId, targetLevel: targetLevel ?? null },
        createdAt: now,
      },
      { session },
    );
    await logEvent({
      type: kind === "EMERGENCY_EXIT" ? "EMERGENCY_EXIT" : kind === "TARGET_EXIT" ? "PROFIT_TAKEN" : "TRADE_EXECUTED",
      source: "paper", userId, message: `PAPER sell ${token.symbol}: ${reason}`, data: { positionId, tradeId, realizedDeltaUsd: res.realizedDeltaUsd },
    });
    if (res.closed) await logEvent({ type: "POSITION_CLOSED", source: "paper", userId, message: `Position closed: ${token.symbol} (realised ${res.realizedPnlUsd >= 0 ? "+" : ""}$${res.realizedPnlUsd.toFixed(2)})`, data: { positionId } });
    return { ok: true as const, tradeId, closed: res.closed, realizedDeltaUsd: res.realizedDeltaUsd };
  });
}

async function executePaperSellTrade(tradeId: string): Promise<never> {
  // PAPER exits never go through PREPARED trades; exits call paperSell directly.
  const trades = await collections.trades();
  await trades.updateOne({ _id: tradeId }, { $set: { status: "CANCELLED", failureReason: "Unsupported for PAPER" } });
  throw new TradeError("Paper exits are executed directly via the close-position endpoint", 400);
}

// ───────────────────────────── LIVE ─────────────────────────────

/**
 * LIVE: the browser wallet signed and broadcast the prepared (unsigned) transaction. We never hold keys and never
 * broadcast on the user's behalf; we only record the signature and follow it to confirmation on-chain.
 */
async function recordLiveSignature(userId: string, trade: TradeDoc, signature?: string) {
  if (!signature || !/^[1-9A-HJ-NP-Za-km-z]{64,90}$/.test(signature)) throw new TradeError("A valid transaction signature is required for LIVE trades", 400);
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
      await positions.insertOne(
        {
          _id: positionId, userId: trade.userId, accountId: trade.accountId, tokenId: trade.tokenId, environment: "LIVE", status: "OPEN", health: "HOLD",
          healthNotes: { entryLiquidityUsd: token.liquidityUsd },
          origin: trade.kind === "AUTO_ENTRY" ? "AUTO" : "MANUAL",
          sourceSignalId: (trade.quote as { signalId?: string | null } | null)?.signalId ?? null,
          entryPriceUsd: buyCostUsd / tokenAmountActual, currentPriceUsd: token.priceUsd, initialAmount: tokenAmountActual, amount: tokenAmountActual,
          investedUsd: buyCostUsd, costBasisUsd: buyCostUsd, realizedPnlUsd: 0, targetsHit: 0,
          targetsSnapshot: settings.targets, emergencyEnabled: settings.emergencyEnabled, emergencyAutoExit: settings.emergencyAutoExit,
          openedAt: now, updatedAt: now, closedAt: null, lastAnalysisAt: null,
        },
        { session },
      );
      await positionEvents.insertOne({ _id: newId(), positionId, type: "OPENED", message: "LIVE entry confirmed on-chain", data: { tradeId }, createdAt: now }, { session });
      await trades.updateOne({ _id: tradeId }, { $set: { status: "CONFIRMED", positionId, executedAt: now } }, { session });
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
  return { trade: withId(doc), created: true as const };
}

export const FEE_DEFAULTS = FEES;
export type { ProfitTargetConfig };
