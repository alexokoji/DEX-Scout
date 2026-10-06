import type { Filter, Sort } from "mongodb";
import { z } from "zod";
import { capitalSnapshot } from "@/core/trading/capital";
import { PRICE_MAX_AGE_MS } from "@/core/config";
import { TRUST_RANK, TRUST_TIERS, type TrustTier } from "@/core/types";
import { computeMetrics } from "@/core/trading/positions";
import { walletResult } from "@/core/trading/walletResult";
import { collections, withId, withIds } from "@/lib/db";
import type { Environment, RiskLevel, SignalDoc, TokenDoc } from "@/lib/models";
import { getSettings } from "./settings";
import { capitalState, reconcileUserPending } from "./trading";
import { autoSellsFor } from "./autoSell";
import { refreshTokenIfStale } from "./tokenPrice";
import { walletBalances } from "./walletBalance";

export { walletBalances };
import { workerStatuses } from "./workerState";

const RISK_LEVELS: RiskLevel[] = ["LOWER", "MODERATE", "HIGH", "CRITICAL"];
const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export const tokenQuerySchema = z.object({
  q: z.string().optional(),
  sort: z.enum(["marketCapUsd", "priceUsd", "liquidityUsd", "volume24hUsd", "change5m", "change1h", "buySellRatio", "holders", "holderGrowth1h", "opportunityScore", "updatedAt", "poolCreatedAt"]).default("opportunityScore"),
  dir: z.enum(["asc", "desc"]).default("desc"),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(5).max(200).default(25),
  minMcap: z.coerce.number().min(0).optional(),
  maxMcap: z.coerce.number().min(0).optional(),
  minLiq: z.coerce.number().min(0).optional(),
  minVol: z.coerce.number().min(0).optional(),
  risk: z.string().optional(), // comma separated RiskLevel list
  signal: z.enum(["BUY", "WATCH", "ANY", "NONE"]).optional(),
  dex: z.string().optional(),
  chain: z.string().optional(),
  /** true = only tokens passing scanner filters (Signals page); false/undefined = everything discovered */
  passing: z.enum(["true", "false"]).optional(),
  /** "true" also lists tokens whose price hasn't been refreshed within PRICE_MAX_AGE_MS (hidden by default: their price is not real) */
  stale: z.enum(["true"]).optional(),
  /**
   * The least-earned trust to list (see core/analysis/trust.ts). A token that hasn't been checked yet counts as below every
   * tier. ALL (the default for a query that doesn't say) lists everything.
   */
  trust: z.enum(["VERIFIED", "TRUSTED", "UNPROVEN", "ALL"]).optional(),
});
export type TokenQuery = z.infer<typeof tokenQuerySchema>;

/** Find a token by address (optionally scoped to a chain). EVM addresses are stored lower-cased. */
export async function findToken(address: string, chain?: string) {
  const a = address.startsWith("0x") ? address.toLowerCase() : address;
  const tokens = await collections.tokens();
  const t = await tokens.findOne({ address: a, ...(chain ? { chain } : {}) });
  return t ? withId(t) : null;
}

/** The token page + its detail API: the token plus its one active signal (with the signal's own embedded AI analysis), if any. */
export async function getTokenDetail(address: string, chain?: string) {
  let token = await findToken(address, chain);
  if (!token) return null;
  // Someone opening a token page may be about to trade it: make sure the price on screen is live, not whatever the last scan left.
  if (await refreshTokenIfStale(token)) token = (await findToken(address, chain)) ?? token;
  const signalsCol = await collections.signals();
  const sig = await signalsCol.findOne({ tokenId: token.id, status: "ACTIVE" }, { sort: { createdAt: -1 } });
  return { token, signal: sig ? withId(sig) : null };
}

export async function listTokens(query: TokenQuery) {
  const tokensCol = await collections.tokens();
  const signalsCol = await collections.signals();
  const where: Filter<TokenDoc> = {};
  if (query.q) {
    const rx = new RegExp(escapeRegex(query.q), "i");
    where.$or = [{ symbol: rx }, { name: rx }, { address: new RegExp("^" + escapeRegex(query.q)) }];
  }
  if (query.minMcap !== undefined || query.maxMcap !== undefined) where.marketCapUsd = { ...(query.minMcap !== undefined ? { $gte: query.minMcap } : {}), ...(query.maxMcap !== undefined ? { $lte: query.maxMcap } : {}) };
  if (query.minLiq !== undefined) where.liquidityUsd = { $gte: query.minLiq };
  if (query.minVol !== undefined) where.volume24hUsd = { $gte: query.minVol };
  if (query.risk) {
    const levels = query.risk.split(",").filter((r): r is RiskLevel => RISK_LEVELS.includes(r as RiskLevel));
    if (levels.length) where.riskLevel = { $in: levels };
  }
  if (query.dex) where.dex = new RegExp(`^${escapeRegex(query.dex)}$`, "i");
  if (query.chain) where.chain = query.chain;
  if (query.passing === "true") where.passedFilters = true;
  const trustTiers = query.trust && query.trust !== "ALL" ? TRUST_TIERS.filter((t) => TRUST_RANK[t] >= TRUST_RANK[query.trust as TrustTier]) : null;
  // A chain no checking service covers can't produce a trusted token, however good it is, so a trust floor would hide the whole
  // chain. Its tokens stay listed (labelled "can't be verified") instead of vanishing; the bot still won't buy them.
  const trustCond = (trustTiers ? { $or: [{ trustTier: { $in: trustTiers } }, { "trust.unverifiable": true }] } : null) as Filter<TokenDoc> | null;
  const baseWhere = { ...where };
  if (trustCond) where.$and = [...(where.$and ?? []), trustCond];
  // A price that hasn't been refreshed recently isn't a price: keep those out of the lists unless asked.
  const staleCutoff = new Date(Date.now() - PRICE_MAX_AGE_MS);
  if (query.stale !== "true") where.lastScannedAt = { $gte: staleCutoff };
  if (query.signal) {
    const cond = query.signal === "BUY" || query.signal === "WATCH" ? { status: "ACTIVE" as const, type: query.signal } : { status: "ACTIVE" as const, type: { $in: ["BUY", "WATCH"] as const } };
    const ids = await signalsCol.distinct("tokenId", cond);
    where._id = query.signal === "NONE" ? { $nin: ids } : { $in: ids };
  }

  const sort: Sort = { [query.sort]: query.dir === "asc" ? 1 : -1, _id: 1 };
  const [total, rows] = await Promise.all([
    tokensCol.countDocuments(where),
    tokensCol.find(where).sort(sort).skip((query.page - 1) * query.pageSize).limit(query.pageSize).toArray(),
  ]);
  const activeSignals = await signalsCol
    .find({ tokenId: { $in: rows.map((r) => r._id) }, status: "ACTIVE" }, { projection: { _id: 1, tokenId: 1, type: 1, score: 1 }, sort: { createdAt: -1 } })
    .toArray();
  const signalByToken = new Map<string, { id: string; type: string; score: number }>();
  for (const s of activeSignals) if (!signalByToken.has(s.tokenId)) signalByToken.set(s.tokenId, { id: s._id, type: s.type, score: s.score });
  const withSignals = withIds(rows).map((t) => ({ ...t, signals: signalByToken.has(t.id) ? [signalByToken.get(t.id)!] : [] }));
  // how many matching tokens were left out for having an old price (for the "show them" link)
  const staleHidden = query.stale === "true" ? 0 : await tokensCol.countDocuments({ ...where, lastScannedAt: { $lt: staleCutoff } });
  // how many (otherwise matching) tokens the trust floor left out, for the "show them" link
  const hiddenByChain = trustCond
    ? (await tokensCol.aggregate<{ _id: string; n: number }>([{ $match: { ...baseWhere, $nor: [trustCond] } }, { $group: { _id: "$chain", n: { $sum: 1 } } }, { $sort: { n: -1 } }]).toArray()).map((g) => ({ chain: g._id, n: g.n }))
    : [];
  const untrustedHidden = hiddenByChain.reduce((s, g) => s + g.n, 0);
  return { total, page: query.page, pageSize: query.pageSize, pages: Math.max(1, Math.ceil(total / query.pageSize)), staleHidden, untrustedHidden, hiddenByChain, rows: withSignals };
}

export async function attachTokens<T extends { tokenId: string }>(rows: T[]): Promise<(T & { token: ReturnType<typeof withId<TokenDoc>> })[]> {
  const tokensCol = await collections.tokens();
  const tokens = await tokensCol.find({ _id: { $in: [...new Set(rows.map((r) => r.tokenId))] } }).toArray();
  const byId = new Map(tokens.map((t) => [t._id, withId(t)]));
  return rows.flatMap((r) => {
    const token = byId.get(r.tokenId);
    return token ? [{ ...r, token }] : [];
  });
}

export async function listSignals(opts: { page: number; pageSize: number; type?: string; risk?: string; q?: string; sort?: string; minScore?: number; activeOnly?: boolean; minMcap?: number; maxMcap?: number; dex?: string }) {
  const signalsCol = await collections.signals();
  const tokensCol = await collections.tokens();
  const where: Filter<SignalDoc> = {};
  if (opts.activeOnly !== false) where.status = "ACTIVE";
  if (opts.type === "BUY" || opts.type === "WATCH") where.type = opts.type;
  if (opts.minScore) where.score = { $gte: opts.minScore };
  if (opts.risk) {
    const levels = opts.risk.split(",").filter((r): r is RiskLevel => RISK_LEVELS.includes(r as RiskLevel));
    if (levels.length) where.riskLevel = { $in: levels };
  }

  const tokenWhere: Filter<TokenDoc> = {};
  if (opts.q) {
    const rx = new RegExp(escapeRegex(opts.q), "i");
    tokenWhere.$or = [{ symbol: rx }, { name: rx }];
  }
  if (opts.minMcap !== undefined || opts.maxMcap !== undefined) tokenWhere.marketCapUsd = { ...(opts.minMcap !== undefined ? { $gte: opts.minMcap } : {}), ...(opts.maxMcap !== undefined ? { $lte: opts.maxMcap } : {}) };
  if (opts.dex) tokenWhere.dex = new RegExp(`^${escapeRegex(opts.dex)}$`, "i");
  if (Object.keys(tokenWhere).length) {
    const ids = await tokensCol.distinct("_id", tokenWhere);
    where.tokenId = { $in: ids };
  }

  const sort: Sort = opts.sort === "created" ? { createdAt: -1 } : { score: -1 };
  const [total, rows] = await Promise.all([
    signalsCol.countDocuments(where),
    signalsCol.find(where).sort(sort).skip((opts.page - 1) * opts.pageSize).limit(opts.pageSize).toArray(),
  ]);
  return { total, pages: Math.max(1, Math.ceil(total / opts.pageSize)), rows: await attachTokens(withIds(rows)) };
}

export async function positionViews(userId: string, environment?: Environment, includeClosed = false) {
  await reconcileUserPending(userId); // a sale that has confirmed since the last look is booked before positions are listed
  const positionsCol = await collections.positions();
  const signalsCol = await collections.signals();
  const rows = withIds(
    await positionsCol
      .find({ userId, ...(environment ? { environment } : {}), ...(includeClosed ? {} : { status: { $ne: "CLOSED" } }) })
      .sort({ openedAt: -1 })
      .toArray(),
  );
  const withToken = await attachTokens(rows);
  const signalIds = [...new Set(withToken.map((p) => p.sourceSignalId).filter((x): x is string => !!x))];
  const signals = signalIds.length ? await signalsCol.find({ _id: { $in: signalIds } }, { projection: { _id: 1, type: 1, score: 1, createdAt: 1 } }).toArray() : [];
  const signalById = new Map(signals.map((s) => [s._id, { id: s._id, type: s.type, score: s.score, createdAt: s.createdAt }]));

  const autoSells = await autoSellsFor(withToken.map((p) => p.id));
  const ids = withToken.map((p) => p.id);
  const tradeRows = ids.length ? await (await collections.trades()).find({ positionId: { $in: ids }, status: "CONFIRMED" }, { projection: { positionId: 1, walletChange: 1 } }).toArray() : [];
  const reclaims = ids.length ? await (await collections.positionEvents()).find({ positionId: { $in: ids }, type: "DEPOSIT_RECLAIMED" }, { projection: { positionId: 1, data: 1 } }).toArray() : [];
  const tradesBy = new Map<string, typeof tradeRows>();
  for (const t of tradeRows) tradesBy.set(t.positionId!, [...(tradesBy.get(t.positionId!) ?? []), t]);
  const reclaimedUsd = new Map<string, number>();
  for (const e of reclaims) {
    const d = (e.data ?? {}) as { refundNative?: number; nativeUsd?: number };
    reclaimedUsd.set(e.positionId, (reclaimedUsd.get(e.positionId) ?? 0) + (d.refundNative ?? 0) * (d.nativeUsd ?? 0));
  }
  return withToken.map((p) => {
    const targets = p.targetsSnapshot ?? [];
    const m = computeMetrics(
      { entryPriceUsd: p.entryPriceUsd, initialAmount: p.initialAmount, amount: p.amount, costBasisUsd: p.costBasisUsd, targetsHit: p.targetsHit },
      p.currentPriceUsd,
      targets,
    );
    return { ...p, autoSells: (autoSells.get(p.id) ?? []).map(({ _id, ...o }) => ({ id: _id, ...o })), targets, signal: p.sourceSignalId ? (signalById.get(p.sourceSignalId) ?? null) : null, metrics: m, wallet: walletResult(tradesBy.get(p.id) ?? [], reclaimedUsd.get(p.id) ?? 0) };
  });
}

export async function portfolio(userId: string, environment: Environment) {
  const settings = await getSettings(userId);
  const accountsCol = await collections.tradingAccounts();
  const [views, state, account, wb] = await Promise.all([
    positionViews(userId, environment),
    capitalState(userId, environment),
    accountsCol.findOne({ userId, environment }),
    walletBalances(userId, settings.filters.chains),
  ]);
  // capital is the connected wallet's balance, not a typed-in number
  const cap = capitalSnapshot(settings, { ...state, walletUsd: wb.wallets.length ? wb.totalUsd : null });
  const openValue = views.reduce((s, v) => s + v.metrics.currentValueUsd, 0);
  // unrealized P/L is on price, the way the positions page and the targets see it
  const unrealized = views.reduce((s, v) => s + v.metrics.pricePnlUsd, 0);
  return {
    environment,
    capital: cap,
    openPositionValueUsd: openValue,
    unrealizedPnlUsd: unrealized,
    realizedPnlUsd: account?.realizedPnlUsd ?? 0,
    wallet: wb.wallets.length ? { address: wb.wallets.map((w) => w.address).join(", "), summary: wb.summary, balanceUsd: wb.totalUsd } : null,
    positions: views.length,
  };
}

export async function dashboard(userId: string) {
  const settings = await getSettings(userId);
  const env: Environment = "LIVE";
  const startOfDay = new Date();
  startOfDay.setHours(0, 0, 0, 0);

  const [signalsCol, tradesCol, botsCol, tokensCol, eventsCol] = await Promise.all([
    collections.signals(), collections.trades(), collections.bots(), collections.tokens(), collections.systemEvents(),
  ]);

  const fresh = new Date(Date.now() - PRICE_MAX_AGE_MS); // counts and market averages only use tokens whose price is current
  const [pf, todaySignals, activeSignals, tradesToday, recentSignalsRaw, positions, recentTradesRaw, botRaw, workers, tokenCount, passing, events, marketAgg] = await Promise.all([
    portfolio(userId, env),
    signalsCol.countDocuments({ createdAt: { $gte: startOfDay } }),
    signalsCol.countDocuments({ status: "ACTIVE" }),
    tradesCol.countDocuments({ userId, createdAt: { $gte: startOfDay }, status: "CONFIRMED" }),
    signalsCol.find({ status: "ACTIVE" }).sort({ score: -1 }).limit(6).toArray(),
    positionViews(userId, env),
    tradesCol.find({ userId }).sort({ createdAt: -1 }).limit(6).toArray(),
    botsCol.findOne({ userId }),
    workerStatuses(),
    tokensCol.countDocuments({ lastScannedAt: { $gte: fresh } }),
    tokensCol.countDocuments({ passedFilters: true, lastScannedAt: { $gte: fresh } }),
    eventsCol.find({}).sort({ ts: -1 }).limit(8).toArray(),
    tokensCol.aggregate<{ avgChange1h: number | null; avgBuySellRatio: number | null; sumVolume24h: number | null }>([
      { $match: { passedFilters: true, lastScannedAt: { $gte: fresh } } },
      { $group: { _id: null, avgChange1h: { $avg: "$change1h" }, avgBuySellRatio: { $avg: "$buySellRatio" }, sumVolume24h: { $sum: "$volume24hUsd" } } },
    ]).toArray(),
  ]);

  const market = marketAgg[0] ?? { avgChange1h: 0, avgBuySellRatio: 0, sumVolume24h: 0 };
  return {
    settings, env, pf, todaySignals, activeSignals, tradesToday,
    recentSignals: await attachTokens(withIds(recentSignalsRaw)),
    positions: positions.slice(0, 6),
    recentTrades: await attachTokens(withIds(recentTradesRaw)),
    bot: botRaw ? withId(botRaw) : null,
    workers, tokenCount, passing,
    events: withIds(events),
    market: { _avg: { change1h: market.avgChange1h ?? 0, buySellRatio: market.avgBuySellRatio ?? 0 }, _sum: { volume24hUsd: market.sumVolume24h ?? 0 } },
  };
}

export async function botOverview(userId: string) {
  const settings = await getSettings(userId);
  const env: Environment = "LIVE";
  const startOfDay = new Date();
  startOfDay.setHours(0, 0, 0, 0);

  const [botsCol, tradesCol, botRunsCol, eventsCol] = await Promise.all([collections.bots(), collections.trades(), collections.botRuns(), collections.systemEvents()]);
  const botRaw = await botsCol.findOne({ userId });

  const [pf, tradesToday, runsRaw, eventsRaw, evaluatedAgg] = await Promise.all([
    portfolio(userId, env),
    tradesCol.countDocuments({ userId, createdAt: { $gte: startOfDay }, status: "CONFIRMED" }),
    botRaw ? botRunsCol.find({ botId: botRaw._id }).sort({ startedAt: -1 }).limit(10).toArray() : Promise.resolve([]),
    eventsCol.find({ $or: [{ userId }, { source: "bot" }], type: { $in: ["BOT_STARTED", "BOT_PAUSED", "BOT_STOPPED", "TRADE_REQUESTED", "TRADE_EXECUTED", "TRADE_FAILED", "TRADE_SKIPPED", "POSITION_OPENED", "PROFIT_TAKEN", "EMERGENCY_WARNING", "EMERGENCY_EXIT"] } }).sort({ ts: -1 }).limit(25).toArray(),
    botRaw ? botRunsCol.aggregate<{ signalsEvaluated: number; tradesExecuted: number }>([{ $match: { botId: botRaw._id } }, { $group: { _id: null, signalsEvaluated: { $sum: "$signalsEvaluated" }, tradesExecuted: { $sum: "$tradesExecuted" } } }]).toArray() : Promise.resolve([]),
  ]);

  const totals = evaluatedAgg[0] ?? { signalsEvaluated: 0, tradesExecuted: 0 };
  return { settings, env, bot: botRaw ? withId(botRaw) : null, pf, tradesToday, runs: withIds(runsRaw), events: withIds(eventsRaw), totals };
}
