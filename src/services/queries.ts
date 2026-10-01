import type { Filter, Sort } from "mongodb";
import { z } from "zod";
import { CHAIN_IDS, CHAINS } from "@/core/chains";
import { capitalSnapshot } from "@/core/trading/capital";
import { computeMetrics } from "@/core/trading/positions";
import { providers } from "@/core/providers/registry";
import { collections, withId, withIds } from "@/lib/db";
import type { Environment, RiskLevel, SignalDoc, TokenDoc } from "@/lib/models";
import { getSettings } from "./settings";
import { capitalState } from "./trading";
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
  const token = await findToken(address, chain);
  if (!token) return null;
  const signalsCol = await collections.signals();
  const sig = await signalsCol.findOne({ tokenId: token.id, status: "ACTIVE" }, { sort: { createdAt: -1 } });
  return { token, signal: sig ? withId(sig) : null };
}

/** Native balances of every linked wallet: Solana wallets on Solana, EVM wallets on every EVM chain. */
export async function walletBalances(userId: string) {
  const walletsCol = await collections.wallets();
  const wallets = withIds(await walletsCol.find({ userId }).sort({ createdAt: -1 }).toArray());
  const p = providers();
  const balances: { family: string; address: string; chain: string; symbol: string; amount: number; usd: number }[] = [];
  await Promise.all(
    wallets.flatMap((w) =>
      (w.chain === "evm" ? CHAIN_IDS.filter((c) => CHAINS[c].family === "evm") : (["solana"] as const)).map(async (c) => {
        const a = p.chains[c];
        const [amount, px] = await Promise.all([a.getNativeBalance(w.address).catch(() => null), a.nativeUsdPrice().catch(() => 0)]);
        if (amount !== null) balances.push({ family: w.chain, address: w.address, chain: c, symbol: CHAINS[c].nativeSymbol, amount, usd: amount * px });
      }),
    ),
  );
  balances.sort((x, y) => y.usd - x.usd);
  const totalUsd = balances.reduce((s, b) => s + b.usd, 0);
  const summary = balances.filter((b) => b.amount > 0).slice(0, 4).map((b) => `${b.amount.toFixed(3)} ${b.symbol}${b.chain === "solana" || b.symbol !== "ETH" ? "" : " (" + CHAINS[b.chain as keyof typeof CHAINS].name + ")"}`).join(" · ");
  return { wallets: wallets.map((w) => ({ address: w.address, family: w.chain })), balances, totalUsd, summary };
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
  return { total, page: query.page, pageSize: query.pageSize, pages: Math.max(1, Math.ceil(total / query.pageSize)), rows: withSignals };
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

  return withToken.map((p) => {
    const targets = p.targetsSnapshot ?? [];
    const m = computeMetrics(
      { entryPriceUsd: p.entryPriceUsd, initialAmount: p.initialAmount, amount: p.amount, costBasisUsd: p.costBasisUsd, targetsHit: p.targetsHit },
      p.currentPriceUsd,
      targets,
    );
    return { ...p, targets, signal: p.sourceSignalId ? (signalById.get(p.sourceSignalId) ?? null) : null, metrics: m };
  });
}

export async function portfolio(userId: string, environment: Environment) {
  const settings = await getSettings(userId);
  const accountsCol = await collections.tradingAccounts();
  const [views, state, account, wb] = await Promise.all([
    positionViews(userId, environment),
    capitalState(userId, environment),
    accountsCol.findOne({ userId, environment }),
    walletBalances(userId),
  ]);
  const cap = capitalSnapshot(settings, state);
  const openValue = views.reduce((s, v) => s + v.metrics.currentValueUsd, 0);
  const unrealized = views.reduce((s, v) => s + v.metrics.unrealizedPnlUsd, 0);
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
    tokensCol.countDocuments({}),
    tokensCol.countDocuments({ passedFilters: true }),
    eventsCol.find({}).sort({ ts: -1 }).limit(8).toArray(),
    tokensCol.aggregate<{ avgChange1h: number | null; avgBuySellRatio: number | null; sumVolume24h: number | null }>([
      { $match: { passedFilters: true } },
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
