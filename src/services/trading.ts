import type { Environment, Prisma, Trade, TradeKind } from "@prisma/client";
import { z } from "zod";
import { CHAIN_IDS, CHAINS, normalizeAddress } from "@/core/chains";
import { FEES } from "@/core/config";
import { providers } from "@/core/providers/registry";
import { checkManualAmount, type CapitalState } from "@/core/trading/capital";
import { simulateFill } from "@/core/trading/paperBroker";
import { applySell, deriveStatus } from "@/core/trading/positions";
import { validateEntry, validateSlippage } from "@/core/trading/validation";
import type { Analysis, ChainId, ProfitTargetConfig, SwapQuote } from "@/core/types";
import { db, withUserLock, type Tx } from "@/lib/db";
import { liveTradingAllowed } from "@/lib/env";
import { logEvent, safeMessage } from "@/lib/events";
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

export async function getOrCreateAccount(tx: Tx | typeof db, userId: string, environment: Environment) {
  return tx.tradingAccount.upsert({
    where: { userId_environment: { userId, environment } },
    create: { userId, environment },
    update: {},
  });
}

export async function capitalState(tx: Tx | typeof db, userId: string, environment: Environment): Promise<CapitalState> {
  const open = await tx.position.findMany({
    where: { userId, environment, status: { not: "CLOSED" } },
    select: { costBasisUsd: true },
  });
  return { deployedUsd: open.reduce((s, p) => s + p.costBasisUsd, 0), openPositions: open.length };
}

function quoteJson(q: SwapQuote): Prisma.InputJsonValue {
  return { ...q, raw: q.raw ?? null } as unknown as Prisma.InputJsonValue;
}

/** Fresh analysis for a token, re-computed on demand if the stored one is missing/stale. */
export async function ensureAnalysis(token: { id: string; address: string; chain: string }, maxAgeMs = 2 * 60_000): Promise<Analysis> {
  const tokenId = token.id;
  const address = token.address;
  const chain = token.chain as ChainId;
  const cached = await loadAnalysis(tokenId);
  if (cached && Date.now() - cached.computedAt.getTime() < maxAgeMs) return cached;
  const p = providers();
  const snap = await p.data.getSnapshot(chain, address);
  if (!snap) throw new TradeError("Token not found or no longer tradeable", 404);
  const raw = await p.data.getOnChain(chain, address, snap);
  const a = await analyzeSnapshot(snap, raw);
  await persistAnalysis(tokenId, a);
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
  const w = await db.wallet.findFirst({ where: { userId, chain: walletFamily(chain) }, orderBy: { createdAt: "desc" } });
  if (!w) throw new TradeError(`Connect and verify a ${walletFamily(chain) === "evm" ? "EVM" : "Solana"} wallet before trading LIVE on ${CHAINS[chain as ChainId]?.name ?? chain}`, 400);
  return w;
}

/** Non-persisting quote + eligibility check used by the trading panel for live feedback. */
export async function quoteTrade(userId: string, input: PrepareTradeInput, automatic = false) {
  assertEnvironment(input.environment);
  const settings = await getSettings(userId);
  const token = await db.token.findFirst({ where: { chain: input.chain, address: normalizeAddress(input.chain, input.tokenAddress) } });
  if (!token) throw new TradeError("Unknown token", 404);
  const p = providers();
  let quote: SwapQuote;
  try {
    quote = await p.dex.getQuote({ chain: input.chain, side: "BUY", tokenAddress: token.address, amountUsd: input.amountUsd, slippageBps: input.slippageBps, priorityFeeNative: input.priorityFeeNative });
  } catch (err) {
    throw new TradeError(`Quote failed: ${safeMessage(err)}`, 502);
  }
  const analysis = await ensureAnalysis(token);
  const sim = await p.dex.simulateSwap({ chain: input.chain, side: "SELL", tokenAddress: token.address, amountUsd: input.amountUsd, slippageBps: input.slippageBps });
  const state = await capitalState(db, userId, input.environment);
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
  const token = await db.token.findFirstOrThrow({ where: { chain: input.chain, address: normalizeAddress(input.chain, input.tokenAddress) } });
  const account = await getOrCreateAccount(db, userId, input.environment);

  let unsigned: string | null = null;
  if (input.environment === "LIVE") {
    const wallet = await liveWallet(userId, input.chain);
    try {
      unsigned = (await providers().dex.buildSwapTransaction(quote, wallet.address)).unsignedTxBase64;
    } catch (err) {
      throw new TradeError(`Could not build transaction: ${safeMessage(err)}`, 502);
    }
  }

  const trade = await db.trade.create({
    data: {
      userId,
      accountId: account.id,
      tokenId: token.id,
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
      quote: { ...(quoteJson(quote) as object), signalId: input.signalId ?? null } as Prisma.InputJsonValue,
      expiresAt: new Date(Date.now() + PREPARED_TTL_MS),
      ...(unsigned ? { transaction: { create: { unsignedTx: unsigned } } } : {}),
    },
  });
  await logEvent({ type: "TRADE_REQUESTED", source: "trading", userId, message: `${input.environment} buy of $${input.amountUsd} ${token.symbol} prepared`, data: { tradeId: trade.id } });
  return { trade, quote, analysis, unsignedTxBase64: unsigned };
}

/**
 * Execute a PREPARED trade.
 *  - PAPER: simulated fill; a Position is created only if the simulated fill succeeds.
 *  - LIVE:  the user's wallet has already signed & broadcast; we record the signature and confirm it on-chain.
 * The request body never contains prices or amounts — everything is taken from the stored, validated Trade.
 */
export async function executeTrade(userId: string, tradeId: string, opts: { signature?: string } = {}) {
  const trade = await db.trade.findFirst({ where: { id: tradeId, userId }, include: { token: true, transaction: true } });
  if (!trade) throw new TradeError("Trade not found", 404);
  if (trade.status !== "PREPARED") throw new TradeError(`Trade is ${trade.status}, not executable`, 409);
  if (trade.expiresAt && trade.expiresAt.getTime() < Date.now()) {
    await db.trade.update({ where: { id: trade.id }, data: { status: "EXPIRED" } });
    throw new TradeError("Quote expired — request a new quote", 410);
  }
  assertEnvironment(trade.environment);

  if (trade.environment === "LIVE") return recordLiveSignature(userId, trade, opts.signature);
  return trade.side === "BUY" ? executePaperBuy(userId, trade.id) : executePaperSellTrade(userId, trade.id);
}

// ───────────────────────────── PAPER ─────────────────────────────

async function executePaperBuy(userId: string, tradeId: string) {
  const p = providers();
  const settings = await getSettings(userId);
  const trade0 = await db.trade.findUniqueOrThrow({ where: { id: tradeId }, include: { token: true } });
  const chain0 = trade0.token.chain as ChainId;
  const snap = await p.data.getSnapshot(chain0, trade0.token.address);
  const raw = snap ? await p.data.getOnChain(chain0, trade0.token.address, snap) : null;

  return withUserLock(userId, async (tx) => {
    const trade = await tx.trade.findUniqueOrThrow({ where: { id: tradeId }, include: { token: true } });
    if (trade.status !== "PREPARED") throw new TradeError("Trade already processed", 409);

    const state = await capitalState(tx, userId, "PAPER");
    const capErr = checkManualAmount(settings, state, trade.inputUsd);
    // auto entries were already allocated by the bot; re-check hard limits for every entry regardless of origin
    if (capErr && !(trade.kind === "AUTO_ENTRY" && capErr.startsWith("Amount is below"))) {
      await tx.trade.update({ where: { id: trade.id }, data: { status: "FAILED", failureReason: capErr } });
      throw new TradeError(capErr, 422, [capErr]);
    }
    if (!snap || !raw) {
      await tx.trade.update({ where: { id: trade.id }, data: { status: "FAILED", failureReason: "Token no longer tradeable" } });
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
      await tx.trade.update({ where: { id: trade.id }, data: { status: "FAILED", failureReason: fill.reason } });
      await logEvent({ type: "TRADE_FAILED", source: "paper", userId, level: "WARN", message: `Paper buy of ${trade.token.symbol} failed: ${fill.reason}`, data: { tradeId } });
      return { ok: false as const, reason: fill.reason, tradeId };
    }

    const targets = settings.targets;
    const signalId = (trade.quote as { signalId?: string | null } | null)?.signalId ?? null;
    const position = await tx.position.create({
      data: {
        userId,
        accountId: trade.accountId,
        tokenId: trade.tokenId,
        environment: "PAPER",
        status: "OPEN",
        origin: trade.kind === "AUTO_ENTRY" ? "AUTO" : "MANUAL",
        sourceSignalId: signalId,
        entryPriceUsd: fill.fillPriceUsd,
        currentPriceUsd: snap.priceUsd,
        initialAmount: fill.tokenAmount,
        amount: fill.tokenAmount,
        investedUsd: fill.usd,
        costBasisUsd: fill.usd,
        targetsSnapshot: targets as unknown as Prisma.InputJsonValue,
        emergencyEnabled: settings.emergencyEnabled,
        emergencyAutoExit: settings.emergencyAutoExit,
        healthNotes: { entryLiquidityUsd: snap.liquidityUsd, entryRiskLevel: "" } as Prisma.InputJsonValue,
        events: { create: { type: "OPENED", message: `Paper entry at $${fill.fillPriceUsd.toPrecision(5)} for $${fill.usd.toFixed(2)}`, data: { tradeId } } },
      },
    });
    await tx.trade.update({
      where: { id: trade.id },
      data: {
        status: "CONFIRMED",
        positionId: position.id,
        tokenAmount: fill.tokenAmount,
        priceUsd: fill.fillPriceUsd,
        priceImpactPct: fill.priceImpactPct,
        feesUsd: fill.feesUsd,
        networkFeeUsd: fill.networkFeeUsd,
        executedAt: new Date(),
      },
    });
    if (signalId) await tx.signal.updateMany({ where: { id: signalId, status: "ACTIVE" }, data: { status: "CONSUMED" } }).catch(() => {});
    await logEvent({ type: "TRADE_EXECUTED", source: "paper", userId, message: `PAPER buy ${trade.token.symbol} $${fill.usd.toFixed(2)}`, data: { tradeId, positionId: position.id } });
    await logEvent({ type: "POSITION_OPENED", source: "paper", userId, message: `Position opened: ${trade.token.symbol} @ $${fill.fillPriceUsd.toPrecision(5)}`, data: { positionId: position.id } });
    return { ok: true as const, tradeId, positionId: position.id };
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
  const position0 = await db.position.findFirst({ where: { id: positionId, userId, environment: "PAPER" }, include: { token: true } });
  if (!position0) throw new TradeError("Position not found", 404);
  const chain1 = position0.token.chain as ChainId;
  const snap = await p.data.getSnapshot(chain1, position0.token.address);
  const raw = snap ? await p.data.getOnChain(chain1, position0.token.address, snap) : null;
  const settings = await getSettings(userId);

  return withUserLock(userId, async (tx) => {
    const pos = await tx.position.findUniqueOrThrow({ where: { id: positionId }, include: { token: true } });
    if (pos.status === "CLOSED" || pos.amount <= 0) throw new TradeError("Position already closed", 409);
    const amount = Math.min(sellAmount, pos.amount);
    const mid = snap?.priceUsd ?? pos.currentPriceUsd;

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
      await tx.trade.create({
        data: {
          userId, accountId: pos.accountId, tokenId: pos.tokenId, positionId: pos.id, side: "SELL", kind, environment: "PAPER", dataSource: "MOCK", status: "FAILED",
          inputUsd: amount * mid, tokenAmount: amount, priceUsd: mid, priceImpactPct: 0, slippageBps: settings.maxSlippageBps, failureReason: fill.reason, quote: { reason } as Prisma.InputJsonValue,
        },
      });
      await tx.positionEvent.create({ data: { positionId: pos.id, type: "SELL_FAILED", message: `Sell failed: ${fill.reason}` } });
      await logEvent({ type: "TRADE_FAILED", source: "paper", userId, level: "WARN", message: `Paper sell of ${pos.token.symbol} failed: ${fill.reason}`, data: { positionId } });
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

    const trade = await tx.trade.create({
      data: {
        userId, accountId: pos.accountId, tokenId: pos.tokenId, positionId: pos.id, side: "SELL", kind, environment: "PAPER", dataSource: "MOCK", status: "CONFIRMED",
        inputUsd: amount * mid, tokenAmount: amount, priceUsd: fill.fillPriceUsd, priceImpactPct: fill.priceImpactPct, slippageBps: settings.maxSlippageBps,
        feesUsd: fill.feesUsd, networkFeeUsd: fill.networkFeeUsd, realizedPnlUsd: res.realizedDeltaUsd, quote: { reason } as Prisma.InputJsonValue, executedAt: new Date(),
      },
    });
    await tx.position.update({
      where: { id: pos.id },
      data: {
        amount: res.amount, costBasisUsd: res.costBasisUsd, realizedPnlUsd: res.realizedPnlUsd, targetsHit, status,
        currentPriceUsd: mid, closedAt: res.closed ? new Date() : null,
        ...(kind === "EMERGENCY_EXIT" ? { health: "EMERGENCY" as const } : {}),
      },
    });
    await tx.tradingAccount.update({ where: { id: pos.accountId }, data: { realizedPnlUsd: { increment: res.realizedDeltaUsd } } });
    await tx.positionEvent.create({
      data: {
        positionId: pos.id,
        type: kind === "EMERGENCY_EXIT" ? "EMERGENCY_EXIT" : kind === "TARGET_EXIT" ? "PROFIT_TAKEN" : "MANUAL_EXIT",
        message: `${reason}: sold ${amount.toPrecision(6)} tokens @ $${fill.fillPriceUsd.toPrecision(5)} (P/L ${res.realizedDeltaUsd >= 0 ? "+" : ""}$${res.realizedDeltaUsd.toFixed(2)})`,
        data: { tradeId: trade.id, targetLevel: targetLevel ?? null },
      },
    });
    await logEvent({
      type: kind === "EMERGENCY_EXIT" ? "EMERGENCY_EXIT" : kind === "TARGET_EXIT" ? "PROFIT_TAKEN" : "TRADE_EXECUTED",
      source: "paper", userId, message: `PAPER sell ${pos.token.symbol}: ${reason}`, data: { positionId, tradeId: trade.id, realizedDeltaUsd: res.realizedDeltaUsd },
    });
    if (res.closed) await logEvent({ type: "POSITION_CLOSED", source: "paper", userId, message: `Position closed: ${pos.token.symbol} (realised ${res.realizedPnlUsd >= 0 ? "+" : ""}$${res.realizedPnlUsd.toFixed(2)})`, data: { positionId } });
    return { ok: true as const, tradeId: trade.id, closed: res.closed, realizedDeltaUsd: res.realizedDeltaUsd };
  });
}

async function executePaperSellTrade(userId: string, tradeId: string): Promise<never> {
  // PAPER exits never go through PREPARED trades; exits call paperSell directly.
  await db.trade.update({ where: { id: tradeId }, data: { status: "CANCELLED", failureReason: "Unsupported for PAPER" } });
  throw new TradeError("Paper exits are executed directly via the close-position endpoint", 400);
}

// ───────────────────────────── LIVE ─────────────────────────────

/**
 * LIVE: the browser wallet signed and broadcast the prepared (unsigned) transaction. We never hold keys and never
 * broadcast on the user's behalf; we only record the signature and follow it to confirmation on-chain.
 */
async function recordLiveSignature(userId: string, trade: Trade & { transaction: { id: string } | null }, signature?: string) {
  if (!signature || !/^[1-9A-HJ-NP-Za-km-z]{64,90}$/.test(signature)) throw new TradeError("A valid transaction signature is required for LIVE trades", 400);
  await db.$transaction([
    db.trade.update({ where: { id: trade.id }, data: { status: "PENDING" } }),
    db.transaction.update({ where: { tradeId: trade.id }, data: { signature, status: "PENDING", submittedAt: new Date() } }),
  ]);
  await logEvent({ type: "TRADE_EXECUTED", source: "live", userId, message: "LIVE trade submitted by wallet; awaiting confirmation", data: { tradeId: trade.id, signature } });
  return reconcileLiveTrade(trade.id);
}

/** Poll the chain for a PENDING live trade; create/adjust the Position when confirmed. Safe to call repeatedly. */
export async function reconcileLiveTrade(tradeId: string) {
  const trade = await db.trade.findUnique({ where: { id: tradeId }, include: { transaction: true, token: true } });
  if (!trade || trade.status !== "PENDING" || !trade.transaction?.signature) return { ok: false as const, status: trade?.status ?? "MISSING" };
  const st = await providers().dex.getTransactionStatus(trade.token.chain as ChainId, trade.transaction.signature);
  if (st.status === "PENDING" || st.status === "NOT_FOUND") {
    // give up on transactions never seen on-chain after 3 minutes
    if (st.status === "NOT_FOUND" && trade.transaction.submittedAt && Date.now() - trade.transaction.submittedAt.getTime() > 180_000) {
      await db.$transaction([
        db.trade.update({ where: { id: trade.id }, data: { status: "FAILED", failureReason: "Transaction not found on-chain (dropped or timed out)" } }),
        db.transaction.update({ where: { tradeId }, data: { status: "FAILED", error: "timeout" } }),
      ]);
      await logEvent({ type: "TRADE_FAILED", source: "live", userId: trade.userId, level: "WARN", message: `LIVE trade for ${trade.token.symbol} timed out`, data: { tradeId } });
      return { ok: false as const, status: "FAILED" as const };
    }
    return { ok: false as const, status: "PENDING" as const };
  }
  if (st.status === "FAILED") {
    await db.$transaction([
      db.trade.update({ where: { id: trade.id }, data: { status: "FAILED", failureReason: (st.error ?? "Transaction failed on-chain").slice(0, 300) } }),
      db.transaction.update({ where: { tradeId }, data: { status: "FAILED", error: st.error ?? "failed", slot: st.slot ? BigInt(st.slot) : null } }),
    ]);
    await logEvent({ type: "TRADE_FAILED", source: "live", userId: trade.userId, level: "WARN", message: `LIVE trade for ${trade.token.symbol} failed on-chain`, data: { tradeId, error: st.error } });
    return { ok: false as const, status: "FAILED" as const };
  }

  // CONFIRMED: verify the signer and use real on-chain amounts where the adapter can inspect the transaction
  const dex = providers().dex;
  const wallet = await db.wallet.findFirst({ where: { userId: trade.userId, chain: walletFamily(trade.token.chain) }, orderBy: { createdAt: "desc" } });
  const tChain = trade.token.chain as ChainId;
  const insp = dex.inspectTransaction && wallet ? await dex.inspectTransaction(tChain, trade.transaction.signature, wallet.address, trade.token.address).catch(() => null) : null;
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
    await db.$transaction([
      db.trade.update({ where: { id: trade.id }, data: { status: "FAILED", failureReason: mismatch } }),
      db.transaction.update({ where: { tradeId }, data: { status: "FAILED", error: mismatch } }),
    ]);
    await logEvent({ type: "TRADE_FAILED", source: "live", userId: trade.userId, level: "ERROR", message: `LIVE trade ${tradeId}: ${mismatch}; position not changed`, data: { tradeId } });
    return { ok: false as const, status: "FAILED" as const };
  }
  const nativeUsdNow = insp && insp.nativeDelta !== 0 ? await providers().chains[tChain].nativeUsdPrice().catch(() => 0) : 0;
  const realTokens = insp ? Math.abs(insp.tokenDelta) : 0;
  const tokenAmountActual = realTokens > 0 ? realTokens : trade.tokenAmount;
  const buyCostUsd = insp && nativeUsdNow > 0 ? Math.abs(insp.nativeDelta) * nativeUsdNow : trade.inputUsd + trade.networkFeeUsd;
  const sellProceedsUsd = insp && nativeUsdNow > 0 ? Math.max(0, insp.nativeDelta) * nativeUsdNow : trade.inputUsd - trade.feesUsd - trade.networkFeeUsd;
  await withUserLock(trade.userId, async (tx) => {
    const settings = await getSettings(trade.userId);
    await tx.transaction.update({ where: { tradeId }, data: { status: "CONFIRMED", confirmedAt: new Date(), slot: st.slot ? BigInt(st.slot) : null } });
    if (trade.side === "BUY") {
      const position = await tx.position.create({
        data: {
          userId: trade.userId, accountId: trade.accountId, tokenId: trade.tokenId, environment: "LIVE", status: "OPEN",
          origin: trade.kind === "AUTO_ENTRY" ? "AUTO" : "MANUAL",
          sourceSignalId: (trade.quote as { signalId?: string | null } | null)?.signalId ?? null,
          entryPriceUsd: buyCostUsd / tokenAmountActual, currentPriceUsd: trade.token.priceUsd, initialAmount: tokenAmountActual, amount: tokenAmountActual,
          investedUsd: buyCostUsd, costBasisUsd: buyCostUsd,
          targetsSnapshot: settings.targets as unknown as Prisma.InputJsonValue,
          emergencyEnabled: settings.emergencyEnabled, emergencyAutoExit: settings.emergencyAutoExit,
          healthNotes: { entryLiquidityUsd: trade.token.liquidityUsd } as Prisma.InputJsonValue,
          events: { create: { type: "OPENED", message: `LIVE entry confirmed on-chain`, data: { tradeId } } },
        },
      });
      await tx.trade.update({ where: { id: trade.id }, data: { status: "CONFIRMED", positionId: position.id, executedAt: new Date() } });
      await logEvent({ type: "POSITION_OPENED", source: "live", userId: trade.userId, message: `LIVE position opened: ${trade.token.symbol}`, data: { positionId: position.id } });
    } else if (trade.positionId) {
      const pos = await tx.position.findUniqueOrThrow({ where: { id: trade.positionId } });
      const proceeds = sellProceedsUsd;
      const res = applySell(
        { entryPriceUsd: pos.entryPriceUsd, initialAmount: pos.initialAmount, amount: pos.amount, costBasisUsd: pos.costBasisUsd, targetsHit: pos.targetsHit, realizedPnlUsd: pos.realizedPnlUsd },
        tokenAmountActual,
        proceeds,
      );
      const level = (trade.quote as { targetLevel?: number } | null)?.targetLevel;
      const targetsHit = level ? Math.max(pos.targetsHit, level) : pos.targetsHit;
      await tx.position.update({
        where: { id: pos.id },
        data: { amount: res.amount, costBasisUsd: res.costBasisUsd, realizedPnlUsd: res.realizedPnlUsd, targetsHit, closedAt: res.closed ? new Date() : null,
          status: deriveStatus({ closed: res.closed, emergency: trade.kind === "EMERGENCY_EXIT" && !res.closed, targetsHit, unrealizedPnlUsd: res.amount * pos.currentPriceUsd - res.costBasisUsd }) },
      });
      await tx.trade.update({ where: { id: trade.id }, data: { status: "CONFIRMED", executedAt: new Date(), realizedPnlUsd: res.realizedDeltaUsd } });
      await tx.tradingAccount.update({ where: { id: trade.accountId }, data: { realizedPnlUsd: { increment: res.realizedDeltaUsd } } });
      await tx.positionEvent.create({ data: { positionId: pos.id, type: "LIVE_SELL", message: `LIVE sell confirmed on-chain`, data: { tradeId } } });
      if (res.closed) await logEvent({ type: "POSITION_CLOSED", source: "live", userId: trade.userId, message: `LIVE position closed: ${trade.token.symbol}`, data: { positionId: pos.id } });
    }
  });
  await logEvent({ type: "TRADE_EXECUTED", source: "live", userId: trade.userId, message: `LIVE ${trade.side} ${trade.token.symbol} confirmed`, data: { tradeId } });
  return { ok: true as const, status: "CONFIRMED" as const };
}

/** Prepare an unsigned LIVE sell that waits in the user's approval queue (no keys are held server-side). */
export async function prepareLiveSell(userId: string, positionId: string, sellAmount: number, kind: TradeKind, reason: string, targetLevel?: number) {
  assertEnvironment("LIVE");
  const pos = await db.position.findFirst({ where: { id: positionId, userId, environment: "LIVE" }, include: { token: true } });
  if (!pos) throw new TradeError("Position not found", 404);
  const dup = await db.trade.findFirst({ where: { positionId, side: "SELL", kind, status: "PREPARED", expiresAt: { gt: new Date() } } });
  if (dup) return { trade: dup, created: false as const };
  const wallet = await liveWallet(userId, pos.token.chain);
  const settings = await getSettings(userId);
  const amount = Math.min(sellAmount, pos.amount);
  const p = providers();
  const quote = await p.dex.getQuote({ chain: pos.token.chain as ChainId, side: "SELL", tokenAddress: pos.token.address, amountUsd: amount * pos.token.priceUsd, tokenAmount: amount, slippageBps: kind === "EMERGENCY_EXIT" ? 2000 : settings.maxSlippageBps });
  const { unsignedTxBase64 } = await p.dex.buildSwapTransaction(quote, wallet.address);
  const trade = await db.trade.create({
    data: {
      userId, accountId: pos.accountId, tokenId: pos.tokenId, positionId: pos.id, side: "SELL", kind, environment: "LIVE", dataSource: quote.source, status: "PREPARED",
      inputUsd: amount * pos.token.priceUsd, tokenAmount: amount, priceUsd: quote.effectivePriceUsd, priceImpactPct: quote.priceImpactPct, slippageBps: quote.slippageBps,
      feesUsd: quote.platformFeeUsd, networkFeeUsd: quote.networkFeeUsd + quote.priorityFeeUsd,
      quote: { ...(quoteJson(quote) as object), reason, targetLevel: targetLevel ?? null } as Prisma.InputJsonValue,
      expiresAt: new Date(Date.now() + 10 * 60_000),
      transaction: { create: { unsignedTx: unsignedTxBase64 } },
    },
  });
  await logEvent({ type: "TRADE_REQUESTED", source: "live", userId, message: `LIVE ${kind} for ${pos.token.symbol} awaiting wallet approval: ${reason}`, data: { tradeId: trade.id } });
  return { trade, created: true as const };
}

export const FEE_DEFAULTS = FEES;
export type { ProfitTargetConfig };
