import { z } from "zod";
import { CHAIN_IDS, CHAINS, normalizeAddress } from "@/core/chains";
import { FEES } from "@/core/config";
import { providers } from "@/core/providers/registry";
import { explainSolanaOnChainFailure } from "@/core/providers/solana/errors";
import { checkManualAmount, type CapitalState } from "@/core/trading/capital";
import { applySell, deriveStatus } from "@/core/trading/positions";
import { suggestSlippage } from "@/core/trading/slippage";
import { entryWarnings, validateEntry, validateSlippage, type TradeCandidate } from "@/core/trading/validation";
import type { Analysis, ChainId, ProfitTargetConfig, SwapQuote } from "@/core/types";
import { collections, newId, withId, withUserLock, type ClientSession } from "@/lib/db";
import { liveTradingAllowed } from "@/lib/env";
import { logEvent, safeMessage } from "@/lib/events";
import type { Environment, Json, TokenDoc, TradeDoc, TradeKind } from "@/lib/models";
import { analyzeSnapshot, loadAnalysis, persistAnalysis } from "./analysis";
import { getSettings, type UserSettings } from "./settings";
import { notifyUser } from "./notifications";
import { buyQueued, profitTaken, sellQueued, tradeConfirmed, tradeExpired, tradeFailed, type Message } from "./notificationMessages";
import { applyLiveSnapshot } from "./tokenPrice";
import { TradeError } from "./errors";
import { projectedTargets } from "./projection";
import { targetsInput, toLadder } from "./positionTargets";
import { spendableDetail } from "./walletBalance";
import { linkedWallets, resolveWallet, walletFamilyOf } from "./walletResolve";

export { TradeError };

/**
 * Build the unsigned swap and dry-run it as the wallet would, so a swap that would fail is explained here — with what to
 * change — instead of as a wallet "transaction simulation failed" popup. A slippage failure is retried at the next
 * slippage levels the user's own maximum allows, to say which one works (we never raise it silently). Venues without a
 * dry-run (EVM, mock) just build.
 */
async function buildChecked(a: { quote: SwapQuote; wallet: string; maxSlippageBps: number; again: (slippageBps: number) => Promise<SwapQuote> }): Promise<string> {
  const dex = providers().dex;
  const build = async (q: SwapQuote) => {
    try {
      return (await dex.buildSwapTransaction(q, a.wallet)).unsignedTxBase64;
    } catch (err) {
      throw new TradeError(`Could not build transaction: ${safeMessage(err)}`, 502);
    }
  };
  const unsigned = await build(a.quote);
  const pf = dex.preflight ? await dex.preflight(a.quote.chain, unsigned, a.wallet) : ({ ok: true } as const);
  if (pf.ok) return unsigned;
  if (pf.kind !== "slippage") throw new TradeError(pf.error, 422, [pf.error]);

  const tried = a.quote.slippageBps;
  let works: number | null = null;
  for (const bps of [200, 300, 500, 1000, 2000].filter((b) => b > tried && b <= a.maxSlippageBps)) {
    try {
      const q = await a.again(bps);
      const r = dex.preflight ? await dex.preflight(q.chain, await build(q), a.wallet) : ({ ok: true } as const);
      if (r.ok) {
        works = bps;
        break;
      }
    } catch {
      /* try the next level */
    }
  }
  const msg =
    works !== null
      ? `${pf.error} It fails at ${(tried / 100).toFixed(1)}% slippage but passes at ${(works / 100).toFixed(1)}%: set slippage to ${(works / 100).toFixed(1)}% and try again.`
      : `${pf.error} It still fails at your maximum slippage (${(a.maxSlippageBps / 100).toFixed(1)}%): the token is moving too fast right now. Try again in a moment, or raise your maximum slippage in Settings.`;
  throw new TradeError(msg, 422, [msg], works !== null ? { slippageBps: works } : undefined);
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
  /** the address the browser is connected with; used only if it is one of the user's verified wallets */
  wallet: z.string().min(20).max(64).optional(),
  /** a hand-made buy of a token that hasn't earned trust needs the user to say they understand (see prepareTrade) */
  acknowledgeTrust: z.boolean().optional(),
  /** this position's own profit targets (a gain to reach and the share to sell there); without them the default ladder applies (see prepareTrade) */
  targets: targetsInput.optional(),
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
export async function capitalState(userId: string, environment: Environment, session?: ClientSession, chain?: ChainId, walletAddress?: string | null): Promise<CapitalState> {
  const positions = await collections.positions();
  const open = await positions.find({ userId, environment, status: { $ne: "CLOSED" } }, { projection: { costBasisUsd: 1 }, session }).toArray();
  const detail = chain ? await spendableDetail(userId, chain, walletAddress).catch(() => null) : undefined;
  return { deployedUsd: open.reduce((s, p) => s + p.costBasisUsd, 0), openPositions: open.length, walletUsd: chain ? (detail?.balanceUsd ?? null) : undefined, walletLabel: detail?.address ? `${detail.address.slice(0, 6)}…${detail.address.slice(-4)}` : null };
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

/** The wallet to trade with: the one the browser is connected with (if verified), see walletResolve.ts. */
async function liveWallet(userId: string, chain: string, requested?: string | null) {
  const w = await resolveWallet(userId, chain, requested);
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
  // the wallet first: the quote needs it (Solana prices the priority fee from the compute units of this wallet's own swap)
  const wallet = await resolveWallet(userId, input.chain, input.wallet); // throws a clear 409 if the connected wallet isn't verified
  let quote: SwapQuote;
  try {
    quote = await p.dex.getQuote({ chain: input.chain, side: "BUY", tokenAddress: token.address, amountUsd: input.amountUsd, slippageBps: input.slippageBps, priorityFeeNative: input.priorityFeeNative, wallet: wallet?.address });
  } catch (err) {
    throw new TradeError(`Quote failed: ${safeMessage(err)}`, 502);
  }
  const analysis = await ensureAnalysis(withId(token));
  const sim = await p.dex.simulateSwap({ chain: input.chain, side: "SELL", tokenAddress: token.address, amountUsd: input.amountUsd, slippageBps: input.slippageBps });
  const state = await capitalState(userId, input.environment, undefined, input.chain, wallet?.address);
  // A sell check that FAILED to run (a rate-limited or slow provider) is not the same as "this token can't be sold": only the
  // latter blocks. The former is flagged, and the swap itself is dry-run again before the wallet is ever opened.
  const sellUnverified = !sim.ok && !!sim.unknown;
  const candidate = toCandidate(analysis, quote, sim.ok || sellUnverified);
  const violations = evaluateEntryRules(settings, state, input, candidate, automatic);
  if (sellUnverified && automatic) violations.push("Couldn't verify the token can be sold right now (the price service didn't answer); the bot will retry rather than guess");
  // How far is what we'd actually pay from the price the app has been showing (and, for the bot, the price it signalled on)?
  const pricing = priceDrift(token.priceUsd, quote.effectivePriceUsd, token.lastScannedAt);
  // the live snapshot we just analysed is newer than what's stored: bring the displayed price up to date
  if (Date.now() - analysis.computedAt.getTime() < 2 * 60_000 && analysis.snapshot.priceUsd > 0) await applyLiveSnapshot(token._id, analysis.snapshot).catch(() => {});
  if (automatic && pricing.driftPct > AUTO_MAX_CHASE_PCT) violations.push(`Price already moved ${pricing.driftPct.toFixed(0)}% above the listed price (${fmtPrice(token.priceUsd)} → ${fmtPrice(quote.effectivePriceUsd)}); not chasing it`);
  // manual buys get the user's own preference thresholds as warnings; only the bot is blocked by them
  const warnings = automatic
    ? []
    : [
        ...entryWarnings(candidate, settings),
        ...(pricing.warning ? [pricing.warning] : []),
        ...(sellUnverified ? ["Couldn't double-check that this token can be sold back right now (the price service was busy). The swap itself is checked again before your wallet opens."] : []),
      ];
  const walletInfo = wallet ? { address: wallet.address, balanceUsd: state.walletUsd ?? null } : null;
  const slippage = suggestSlippage(analysis.snapshot.change5m, analysis.snapshot.change1h, settings.maxSlippageBps);
  return { quote, pricing, wallet: walletInfo, slippage, trust: analysis.trust, violations, warnings, analysis: { riskLevel: analysis.safety.riskLevel, warnings: analysis.safety.warnings, criticalIssues: analysis.safety.criticalIssues }, source: p.mock ? ("MOCK" as const) : ("LIVE" as const) };
}

/** The bot won't buy more than this far above the price it saw; the rest of the move is not ours to chase. */
export const AUTO_MAX_CHASE_PCT = 10;
/** Differences smaller than this are ordinary spread/impact, not news. */
const DRIFT_WARN_PCT = 5;

const fmtPrice = (n: number) => `$${n >= 1 ? n.toFixed(2) : n.toPrecision(3)}`;

/** Compares the price the app has listed with what a live quote would actually fill at. Pure. */
export function priceDrift(listedUsd: number, effectiveUsd: number, listedAt: Date | null | undefined, now = Date.now()) {
  const ageSec = listedAt ? Math.max(0, Math.round((now - listedAt.getTime()) / 1000)) : null;
  const driftPct = listedUsd > 0 && effectiveUsd > 0 ? (effectiveUsd / listedUsd - 1) * 100 : 0;
  const age = ageSec === null ? "" : ageSec < 90 ? " (seconds old)" : ageSec < 5400 ? ` (${Math.round(ageSec / 60)} min old)` : ` (${(ageSec / 3600).toFixed(1)} h old)`;
  const warning = Math.abs(driftPct) >= DRIFT_WARN_PCT
    ? `The listed price ${fmtPrice(listedUsd)}${age} no longer matches the market: you would buy at about ${fmtPrice(effectiveUsd)} (${driftPct >= 0 ? "+" : ""}${driftPct.toFixed(0)}%).`
    : null;
  return { listedPriceUsd: listedUsd, effectivePriceUsd: effectiveUsd, listedAgeSec: ageSec, driftPct, warning };
}

function toCandidate(analysis: Analysis, quote: SwapQuote, sellSimOk: boolean): TradeCandidate {
  return {
    liquidityUsd: analysis.snapshot.liquidityUsd,
    volume24hUsd: analysis.snapshot.volume24h,
    opportunityScore: analysis.opportunity.score,
    safety: analysis.safety,
    quote,
    sellSimulationOk: sellSimOk && analysis.onchainRaw.sellSimulationOk,
    trust: analysis.trust,
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
  const { quote, violations, analysis, trust } = await quoteTrade(userId, input, kind === "AUTO_ENTRY");
  if (violations.length) throw new TradeError("Trade rejected by validation", 422, violations);
  // The bot only buys what has earned trust (a validation rule above). A person may buy anything that isn't dangerous, but
  // not by accident: for a token that hasn't earned trust they have to say they've seen why.
  if (kind !== "AUTO_ENTRY" && (trust.tier === "UNPROVEN" || trust.tier === "RISKY") && !input.acknowledgeTrust) {
    throw new TradeError(`This token hasn't earned trust. ${trust.summary} Tick the box to confirm you understand the risk.`, 409, [trust.summary], { needsTrustAck: 1 });
  }
  const token = await findTokenOrThrow(input.chain, input.tokenAddress);
  const account = await getOrCreateAccount(userId, input.environment);

  let unsigned: string | null = null;
  let walletAddress: string | null = null;
  if (input.environment === "LIVE") {
    const wallet = await liveWallet(userId, input.chain, input.wallet);
    walletAddress = wallet.address;
    const maxSlippageBps = (await getSettings(userId)).maxSlippageBps;
    unsigned = await buildChecked({
      quote,
      wallet: wallet.address,
      maxSlippageBps,
      again: (slippageBps) => providers().dex.getQuote({ chain: input.chain, side: "BUY", tokenAddress: token.address, amountUsd: input.amountUsd, slippageBps, priorityFeeNative: input.priorityFeeNative, wallet: wallet.address }),
    });
  }

  // This position's own targets: the ones typed for it; else, for the bot, drawn from the token's own history if the user chose that;
  // else none, which means the user's default ladder is used when the position opens.
  let ladder: ProfitTargetConfig[] | null = input.targets ? toLadder(input.targets) : null;
  if (!ladder && kind === "AUTO_ENTRY") {
    const settings = await getSettings(userId);
    if (settings.targetsSource === "PROJECTED") ladder = await projectedTargets(input.chain, token.address, settings.targets).catch(() => null);
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
    quote: { ...(quoteJson(quote) as object), signalId: input.signalId ?? null, wallet: walletAddress, targets: ladder } as Json,
    failureReason: null,
    expiresAt: new Date(Date.now() + (kind === "AUTO_ENTRY" ? APPROVAL_TTL_MS : PREPARED_TTL_MS)),
    createdAt: new Date(),
    executedAt: null,
    transaction: unsigned ? { chain: input.chain, signature: null, status: "PENDING", unsignedTx: unsigned, error: null, slot: null, submittedAt: null, confirmedAt: null, createdAt: new Date() } : null,
  };
  await trades.insertOne(doc);
  await logEvent({ type: "TRADE_REQUESTED", source: "trading", userId, message: `${input.environment} buy of $${input.amountUsd} ${token.symbol} prepared`, data: { tradeId } });
  // A buy the bot queued does nothing until the user signs it. (A hand-made buy is signed right away in front of them.)
  if (kind === "AUTO_ENTRY") await notifyUser(userId, buyQueued(token.symbol, CHAINS[input.chain].name, input.amountUsd, quote.priceImpactPct, tradeId, token._id));
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
export async function refreshPreparedTrade(userId: string, tradeId: string, connectedWallet?: string | null) {
  assertEnvironment("LIVE");
  const trades = await collections.trades();
  const trade = await trades.findOne({ _id: tradeId, userId });
  if (!trade) throw new TradeError("Trade not found", 404);
  const recoverable = trade.status === "PREPARED" || (trade.status === "EXPIRED" && Date.now() - trade.createdAt.getTime() < LATE_SIGNATURE_GRACE_MS);
  if (trade.environment !== "LIVE" || !recoverable || trade.transaction?.signature) throw new TradeError(`Trade is ${trade.status}; it can no longer be refreshed`, 409);

  const token = await getToken(trade.tokenId);
  const chain = token.chain as ChainId;
  const stored = (trade.quote as { wallet?: string | null } | null)?.wallet ?? undefined;
  const wallet = await liveWallet(userId, token.chain, connectedWallet ?? stored);
  const p = providers();

  let quote: SwapQuote;
  if (trade.side === "BUY") {
    const q = await quoteTrade(userId, { chain, tokenAddress: token.address, amountUsd: trade.inputUsd, slippageBps: trade.slippageBps, environment: "LIVE", wallet: wallet.address }, false);
    if (q.violations.length) throw new TradeError("Trade no longer passes validation", 422, q.violations);
    // A queued buy was priced when it was queued; if the market has run away since, entering now is chasing, not the trade that was approved.
    const movedPct = trade.priceUsd > 0 ? (q.quote.effectivePriceUsd / trade.priceUsd - 1) * 100 : 0;
    if (movedPct > AUTO_MAX_CHASE_PCT) throw new TradeError("Price has moved since this trade was queued", 422, [`Queued at ${fmtPrice(trade.priceUsd)}, now ${fmtPrice(q.quote.effectivePriceUsd)} (+${movedPct.toFixed(0)}%). Skipped so you don't enter at a worse price; buy manually if you still want it.`]);
    quote = q.quote;
  } else {
    try {
      quote = await p.dex.getQuote({ chain, side: "SELL", tokenAddress: token.address, amountUsd: trade.inputUsd, tokenAmount: trade.tokenAmount, slippageBps: trade.slippageBps, wallet: wallet.address });
    } catch (err) {
      throw new TradeError(`Quote failed: ${safeMessage(err)}`, 502);
    }
  }
  const unsigned = await buildChecked({
    quote,
    wallet: wallet.address,
    maxSlippageBps: (await getSettings(userId)).maxSlippageBps,
    again: (slippageBps) => p.dex.getQuote({ chain, side: trade.side, tokenAddress: token.address, amountUsd: trade.inputUsd, tokenAmount: trade.side === "SELL" ? trade.tokenAmount : undefined, slippageBps, wallet: wallet.address }),
  });

  const prev = (trade.quote ?? {}) as { signalId?: string | null; reason?: string; targetLevel?: number | null; targets?: ProfitTargetConfig[] | null };
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
        quote: { ...(quoteJson(quote) as object), signalId: prev.signalId ?? null, wallet: wallet.address, targets: prev.targets ?? null, ...(prev.reason ? { reason: prev.reason } : {}), ...(prev.targetLevel !== undefined ? { targetLevel: prev.targetLevel } : {}) } as Json,
        "transaction.unsignedTx": unsigned,
      },
    },
  );
  return { tradeId: trade._id, unsignedTxBase64: unsigned, expiresAt, priceImpactPct: quote.priceImpactPct, side: trade.side, chain };
}

/**
 * Mark prepared trades whose time ran out as EXPIRED, and tell the user about the ones the bot queued for them (a buy or
 * a sell they didn't sign in time). A buy they made by hand and walked away from isn't news.
 */
export async function expirePreparedTrades(now = new Date()): Promise<number> {
  const trades = await collections.trades();
  const due = await trades.find({ status: "PREPARED", expiresAt: { $lt: now } }).toArray();
  if (!due.length) return 0;
  await trades.updateMany({ _id: { $in: due.map((d) => d._id) }, status: "PREPARED" }, { $set: { status: "EXPIRED" } });
  const botQueued = due.filter((d) => d.kind === "AUTO_ENTRY" || d.kind === "TARGET_EXIT" || d.kind === "EMERGENCY_EXIT");
  if (botQueued.length) {
    const tokens = await collections.tokens();
    const rows = await tokens.find({ _id: { $in: [...new Set(botQueued.map((d) => d.tokenId))] } }, { projection: { symbol: 1 } }).toArray();
    const symbol = new Map(rows.map((r) => [r._id, r.symbol]));
    for (const d of botQueued) await notifyUser(d.userId, tradeExpired(d.kind, d.side, symbol.get(d.tokenId) ?? "token", d._id));
  }
  return due.length;
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

/** A failed on-chain transaction's raw error (a JSON string on Solana) as a sentence a person can act on. */
export function humanOnChainFailure(chain: ChainId, raw: string | undefined | null): string {
  if (!raw) return "The transaction failed on-chain";
  if (chain === "solana") {
    let parsed: unknown = raw;
    try {
      parsed = JSON.parse(raw);
    } catch {
      /* not JSON: explain it as text */
    }
    return explainSolanaOnChainFailure(parsed).message;
  }
  return /revert|slippage|too little received|insufficient output/i.test(raw) ? "The swap reverted on-chain, most likely because the price moved past your slippage limit. Only the gas was spent. Try again with a higher slippage if this token is moving fast" : raw.slice(0, 200);
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
      await notifyUser(trade.userId, tradeFailed(trade.side, token.symbol, "Transaction not found on-chain (dropped or timed out)", tradeId));
      return { ok: false as const, status: "FAILED" as const };
    }
    return { ok: false as const, status: "PENDING" as const };
  }
  if (st.status === "FAILED") {
    const reason = humanOnChainFailure(tChain, st.error);
    await trades.updateOne({ _id: tradeId }, { $set: { status: "FAILED", failureReason: reason.slice(0, 300), "transaction.status": "FAILED", "transaction.error": st.error ?? "failed", "transaction.slot": st.slot ?? null } });
    await logEvent({ type: "TRADE_FAILED", source: "live", userId: trade.userId, level: "WARN", message: `LIVE trade for ${token.symbol} failed on-chain`, data: { tradeId, error: st.error } });
    await notifyUser(trade.userId, tradeFailed(trade.side, token.symbol, reason, tradeId));
    return { ok: false as const, status: "FAILED" as const };
  }

  // CONFIRMED: verify the signer and use real on-chain amounts where the adapter can inspect the transaction
  const dex = providers().dex;
  // the wallet this trade was prepared for (falling back to the most recently verified one for older trades)
  const preparedFor = (trade.quote as { wallet?: string | null } | null)?.wallet ?? null;
  const linked = await linkedWallets(trade.userId, walletFamilyOf(token.chain));
  const wallet = preparedFor ? { address: preparedFor } : linked[0] ? { address: linked[0].address } : null;
  const insp = dex.inspectTransaction && wallet ? await dex.inspectTransaction(tChain, trade.transaction.signature, wallet.address, token.address).catch(() => null) : null;
  const sameAddr = (a: string, b: string) => normalizeAddress(tChain, a) === normalizeAddress(tChain, b);
  // The signature must come from the linked wallet AND actually move the expected token in the expected direction
  // (buy: tokens received, sell: tokens sent). Anything else is not the swap we prepared.
  const mismatch = !insp || !wallet
    ? null
    : !sameAddr(insp.signer, wallet.address)
      ? "Transaction was not signed by the wallet it was prepared for"
      : trade.side === "BUY" && insp.tokenDelta <= 0
        ? "Transaction did not deliver the expected token"
        : trade.side === "SELL" && insp.tokenDelta >= 0
          ? "Transaction did not sell the expected token"
          : null;
  if (mismatch) {
    await trades.updateOne({ _id: tradeId }, { $set: { status: "FAILED", failureReason: mismatch, "transaction.status": "FAILED", "transaction.error": mismatch } });
    await logEvent({ type: "TRADE_FAILED", source: "live", userId: trade.userId, level: "ERROR", message: `LIVE trade ${tradeId}: ${mismatch}; position not changed`, data: { tradeId } });
    await notifyUser(trade.userId, tradeFailed(trade.side, token.symbol, mismatch, tradeId));
    return { ok: false as const, status: "FAILED" as const };
  }
  const nativeUsdNow = insp && insp.nativeDelta !== 0 ? await providers().chains[tChain].nativeUsdPrice().catch(() => 0) : 0;
  const realTokens = insp ? Math.abs(insp.tokenDelta) : 0;
  const tokenAmountActual = realTokens > 0 ? realTokens : trade.tokenAmount;
  // What a buy cost = the amount swapped. Not the network fee (already paid, it can't change whether the position is up or
  // down, and on a small buy it made a token that was up on price read as down), and not the native coin that actually left
  // the wallet: on Solana that also contains the one-off ~0.002 SOL deposit for the new token account (recoverable, not a
  // trading cost). The cost basis, the entry price and the profit targets all measure the same thing: the swap.
  const swapUsd = trade.inputUsd;
  const buyCostUsd = swapUsd;
  // What a sell returned = what the swap paid out. The wallet's native balance change already has the network fee taken out of it,
  // so it is added back: the fee is paid either way and has no bearing on whether the position made money (on a $0.10 position a
  // one-cent fee turned a +12% sale into +2%). Falls back to the quote, less the swap's own fee, when the chain can't be read.
  const sellProceedsUsd = insp && nativeUsdNow > 0 ? Math.max(0, insp.nativeDelta + (insp.feeNative ?? 0)) * nativeUsdNow : trade.inputUsd - trade.feesUsd;

  // what the transaction did to the wallet's own balance: shown beside the price-based profit, so the two can be reconciled with the wallet
  const walletChange = insp && insp.nativeDelta !== 0 && nativeUsdNow > 0 ? { nativeDelta: insp.nativeDelta, feeNative: insp.feeNative ?? 0, depositNative: insp.depositNative ?? 0, nativeUsd: nativeUsdNow } : null;

  const positions = await collections.positions();
  const positionEvents = await collections.positionEvents();
  const tradingAccounts = await collections.tradingAccounts();

  // the market price right now, so the new position doesn't start out marked at whatever the last scan stored
  const fresh = trade.side === "BUY" ? await providers().data.getSnapshot(tChain, token.address).catch(() => null) : null;
  const openPriceUsd = fresh && fresh.priceUsd > 0 ? fresh.priceUsd : token.priceUsd;
  let confirmed: Message | null = null;
  let openedPositionId: string | null = null;
  const chainName = CHAINS[tChain]?.name ?? token.chain;
  let booked = false;
  await withUserLock(trade.userId, async (session) => {
    // Settling can be asked for from several places at once (the wallet's own confirmation, a page load, the scheduled job).
    // The lock makes them take turns; whoever comes second finds it already booked and must not book it again.
    const current = await trades.findOne({ _id: tradeId }, { session });
    if (!current || current.status !== "PENDING") return;
    booked = true;
    const settings = await getSettings(trade.userId);
    const now = new Date();
    await trades.updateOne({ _id: tradeId }, { $set: { "transaction.status": "CONFIRMED", "transaction.confirmedAt": now, "transaction.slot": st.slot ?? null, ...(walletChange ? { walletChange } : {}) } }, { session });
    if (trade.side === "BUY") {
      const positionId = newId();
      const signalId = (trade.quote as { signalId?: string | null } | null)?.signalId ?? null;
      const plannedTargets = (trade.quote as { targets?: ProfitTargetConfig[] | null } | null)?.targets ?? null; // the ladder chosen for THIS position
      await positions.insertOne(
        {
          _id: positionId, userId: trade.userId, accountId: trade.accountId, tokenId: trade.tokenId, environment: "LIVE", status: "OPEN", health: "HOLD",
          healthNotes: { entryLiquidityUsd: token.liquidityUsd },
          origin: trade.kind === "AUTO_ENTRY" ? "AUTO" : "MANUAL",
          sourceSignalId: signalId,
          entryPriceUsd: swapUsd / tokenAmountActual, entryMarketPriceUsd: openPriceUsd, currentPriceUsd: openPriceUsd, priceAt: now, initialAmount: tokenAmountActual, amount: tokenAmountActual,
          investedUsd: buyCostUsd, costBasisUsd: buyCostUsd, realizedPnlUsd: 0, targetsHit: 0, walletAddress: wallet?.address ?? null,
          targetsSnapshot: plannedTargets && plannedTargets.length ? plannedTargets : settings.targets, emergencyEnabled: settings.emergencyEnabled, emergencyAutoExit: settings.emergencyAutoExit,
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
      confirmed = tradeConfirmed({ side: "BUY", symbol: token.symbol, chainName, usd: buyCostUsd, tokens: tokenAmountActual, tradeId });
      openedPositionId = positionId;
    } else if (trade.positionId) {
      const pos = await positions.findOne({ _id: trade.positionId }, { session });
      if (!pos) throw new Error(`Position ${trade.positionId} not found while confirming LIVE sell`);
      // The chain reports the tokens that left as a float, so selling "everything" can come back a hair under the position's amount
      // and leave dust that keeps a sold position listed as open. Within a millionth, it was all sold.
      const soldTokens = tokenAmountActual >= pos.amount * (1 - 1e-6) ? pos.amount : tokenAmountActual;
      const res = applySell(
        { entryPriceUsd: pos.entryPriceUsd, initialAmount: pos.initialAmount, amount: pos.amount, costBasisUsd: pos.costBasisUsd, targetsHit: pos.targetsHit, realizedPnlUsd: pos.realizedPnlUsd },
        soldTokens,
        sellProceedsUsd,
      );
      const level = (trade.quote as { targetLevel?: number } | null)?.targetLevel;
      const targetsHit = level ? Math.max(pos.targetsHit, level) : pos.targetsHit;
      await positions.updateOne(
        { _id: pos._id },
        {
          $set: {
            amount: res.amount, costBasisUsd: res.costBasisUsd, realizedPnlUsd: res.realizedPnlUsd, targetsHit, updatedAt: now, closedAt: res.closed ? now : null,
            status: deriveStatus({ closed: res.closed, emergency: trade.kind === "EMERGENCY_EXIT" && !res.closed, targetsHit, unrealizedPnlUsd: res.amount * (pos.currentPriceUsd - pos.entryPriceUsd) }),
          },
        },
        { session },
      );
      await trades.updateOne({ _id: tradeId }, { $set: { status: "CONFIRMED", executedAt: now, realizedPnlUsd: res.realizedDeltaUsd } }, { session });
      await tradingAccounts.updateOne({ _id: trade.accountId }, { $inc: { realizedPnlUsd: res.realizedDeltaUsd } }, { session });
      await positionEvents.insertOne({ _id: newId(), positionId: pos._id, type: "LIVE_SELL", message: "LIVE sell confirmed on-chain", data: { tradeId }, createdAt: now }, { session });
      if (res.closed) await logEvent({ type: "POSITION_CLOSED", source: "live", userId: trade.userId, message: `LIVE position closed: ${token.symbol}`, data: { positionId: pos._id } });
      confirmed = tradeConfirmed({ side: "SELL", symbol: token.symbol, chainName, usd: sellProceedsUsd, tokens: soldTokens, tradeId, realizedDeltaUsd: res.realizedDeltaUsd, closed: res.closed, totalPnlUsd: res.realizedPnlUsd, totalPnlPct: pos.investedUsd > 0 ? (res.realizedPnlUsd / pos.investedUsd) * 100 : undefined });
    }
  });
  if (!booked) return { ok: true as const, status: "CONFIRMED" as const };
  await logEvent({ type: "TRADE_EXECUTED", source: "live", userId: trade.userId, message: `LIVE ${trade.side} ${token.symbol} confirmed`, data: { tradeId } });
  if (confirmed) await notifyUser(trade.userId, confirmed);
  // a position just opened: prepare the sell orders the user can arm with one signature (dynamic import: autoSell imports this module)
  if (openedPositionId) await (await import("./autoSell")).suggestAutoSells(openedPositionId);
  return { ok: true as const, status: "CONFIRMED" as const };
}

/**
 * Settle this user's submitted trades that have confirmed on-chain by now. A sale is signed and sent in seconds, but the first
 * check right after sending usually still sees it pending, so without this a sold position stayed listed as open until the next
 * scheduled run. Called when positions are shown, so what is on screen is what the chain says. Cheap: one status lookup per trade.
 */
export async function reconcileUserPending(userId: string): Promise<void> {
  const trades = await collections.trades();
  const pending = await trades.find({ userId, status: "PENDING", "transaction.signature": { $ne: null } }, { projection: { _id: 1 } }).limit(10).toArray();
  await Promise.all(pending.map((t) => reconcileLiveTrade(t._id).catch(() => {})));
}

/** Prepare an unsigned LIVE sell that waits in the user's approval queue (no keys are held server-side). */
/** Wording for the "a sell is waiting for your signature" notification (kept here as an export for existing callers/tests). */
export const sellQueuedNotification = sellQueued;

export async function prepareLiveSell(userId: string, positionId: string, sellAmount: number, kind: TradeKind, reason: string, targetLevel?: number, connectedWallet?: string) {
  assertEnvironment("LIVE");
  const positions = await collections.positions();
  const trades = await collections.trades();
  const pos = await positions.findOne({ _id: positionId, userId, environment: "LIVE" });
  if (!pos) throw new TradeError("Position not found", 404);
  const dup = await trades.findOne({ positionId, side: "SELL", kind, status: "PREPARED", expiresAt: { $gt: new Date() } });
  if (dup) return { trade: withId(dup), created: false as const };
  const token = await getToken(pos.tokenId);
  // sell from the wallet that holds the tokens (the one that bought), if it is still linked
  const wallet = await liveWallet(userId, token.chain, pos.walletAddress ?? undefined).catch(() => liveWallet(userId, token.chain, connectedWallet));
  const settings = await getSettings(userId);
  const amount = Math.min(sellAmount, pos.amount);
  const p = providers();
  const quote = await p.dex.getQuote({ chain: token.chain as ChainId, side: "SELL", tokenAddress: token.address, amountUsd: amount * token.priceUsd, tokenAmount: amount, slippageBps: kind === "EMERGENCY_EXIT" ? 2000 : settings.maxSlippageBps, wallet: wallet.address });
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

/**
 * Book a sell that settled on-chain WITHOUT passing through our own prepare → sign → reconcile path: a fill of an
 * auto-sell limit order. Same accounting as reconcileLiveTrade's sell branch (position amount/cost basis, realised P/L,
 * targets hit, ledger entry) but from the amounts the order venue itself reports. Returns null if the position is gone.
 */
export async function recordExternalSell(a: {
  userId: string;
  positionId: string;
  tokens: number;
  proceedsUsd: number;
  levels: number[];
  txHash: string | null;
  reason: string;
  orderId: string;
}) {
  const trades = await collections.trades();
  const positions = await collections.positions();
  const positionEvents = await collections.positionEvents();
  const accounts = await collections.tradingAccounts();
  const tradeId = newId();
  type SellResult = { realizedDeltaUsd: number; closed: boolean; totalPnlUsd: number; totalPnlPct: number; symbol: string; chain: string; tokens: number };
  let result = null as SellResult | null; // assigned inside the transaction callback

  await withUserLock(a.userId, async (session) => {
    const pos = await positions.findOne({ _id: a.positionId, userId: a.userId }, { session });
    if (!pos || pos.status === "CLOSED" || pos.amount <= 0) return;
    const token = await getToken(pos.tokenId, session);
    const now = new Date();
    // orders are sized 1e-9 under the position (see autoSell.toDocs), so selling "everything" leaves float dust: treat that as closed
    const sold = a.tokens >= pos.amount * (1 - 1e-6) ? pos.amount : Math.min(a.tokens, pos.amount);
    const res = applySell(
      { entryPriceUsd: pos.entryPriceUsd, initialAmount: pos.initialAmount, amount: pos.amount, costBasisUsd: pos.costBasisUsd, targetsHit: pos.targetsHit, realizedPnlUsd: pos.realizedPnlUsd },
      sold,
      a.proceedsUsd,
    );
    const level = Math.max(0, ...a.levels);
    const targetsHit = Math.max(pos.targetsHit, level);
    await positions.updateOne(
      { _id: pos._id },
      {
        $set: {
          amount: res.amount, costBasisUsd: res.costBasisUsd, realizedPnlUsd: res.realizedPnlUsd, targetsHit, updatedAt: now, closedAt: res.closed ? now : null,
          status: deriveStatus({ closed: res.closed, emergency: false, targetsHit, unrealizedPnlUsd: res.amount * (pos.currentPriceUsd - pos.entryPriceUsd) }),
        },
      },
      { session },
    );
    // a settlement transaction can carry several of one user's orders; the signature index is unique, so only the first keeps it
    const clash = a.txHash ? await trades.findOne({ "transaction.signature": a.txHash }, { projection: { _id: 1 }, session }) : null;
    await trades.insertOne(
      {
        _id: tradeId, userId: a.userId, accountId: pos.accountId, tokenId: pos.tokenId, positionId: pos._id, side: "SELL", kind: "TARGET_EXIT", environment: "LIVE", dataSource: "LIVE", status: "CONFIRMED",
        inputUsd: a.proceedsUsd, tokenAmount: sold, priceUsd: sold > 0 ? a.proceedsUsd / sold : 0, priceImpactPct: 0, slippageBps: 0, feesUsd: 0, networkFeeUsd: 0, realizedPnlUsd: res.realizedDeltaUsd,
        quote: { reason: a.reason, targetLevel: level, autoSell: true, orderId: a.orderId, txHash: a.txHash } as Json,
        failureReason: null, expiresAt: null, createdAt: now, executedAt: now,
        transaction: { chain: token.chain, signature: clash ? null : a.txHash, status: "CONFIRMED", unsignedTx: null, error: null, slot: null, submittedAt: now, confirmedAt: now, createdAt: now },
      },
      { session },
    );
    await accounts.updateOne({ _id: pos.accountId }, { $inc: { realizedPnlUsd: res.realizedDeltaUsd } }, { session });
    await positionEvents.insertOne({ _id: newId(), positionId: pos._id, type: "LIVE_SELL", message: `Auto-sell order filled (${a.reason})`, data: { tradeId, orderId: a.orderId }, createdAt: now }, { session });
    result = { realizedDeltaUsd: res.realizedDeltaUsd, closed: res.closed, totalPnlUsd: res.realizedPnlUsd, totalPnlPct: pos.investedUsd > 0 ? (res.realizedPnlUsd / pos.investedUsd) * 100 : 0, symbol: token.symbol, chain: token.chain, tokens: sold };
    if (res.closed) await logEvent({ type: "POSITION_CLOSED", source: "live", userId: a.userId, message: `LIVE position closed: ${token.symbol} (auto-sell)`, data: { positionId: pos._id } });
  });
  const r = result as SellResult | null;
  if (!r) return null;
  await logEvent({ type: "TRADE_EXECUTED", source: "live", userId: a.userId, message: `Auto-sell filled: ${r.symbol} ${a.reason}`, data: { tradeId } });
  await notifyUser(
    a.userId,
    profitTaken({ symbol: r.symbol, chainName: CHAINS[r.chain as ChainId]?.name ?? r.chain, tokens: r.tokens, proceedsUsd: a.proceedsUsd, realizedDeltaUsd: r.realizedDeltaUsd, closed: r.closed, tradeId, auto: true, totalPnlUsd: r.totalPnlUsd, totalPnlPct: r.totalPnlPct }),
  );
  return { tradeId, ...r };
}

export const FEE_DEFAULTS = FEES;
export type { ProfitTargetConfig };
