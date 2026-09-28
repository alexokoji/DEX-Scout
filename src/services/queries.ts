import type { Environment, Prisma, RiskLevel, SignalType, Token } from "@prisma/client";
import { CHAIN_IDS, CHAINS } from "@/core/chains";
import { z } from "zod";
import { capitalSnapshot } from "@/core/trading/capital";
import { computeMetrics } from "@/core/trading/positions";
import { providers } from "@/core/providers/registry";
import type { ProfitTargetConfig } from "@/core/types";
import { db } from "@/lib/db";
import { getSettings } from "./settings";
import { capitalState } from "./trading";
import { workerStatuses } from "./workerState";

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
export async function findToken(address: string, chain?: string, include?: Prisma.TokenInclude): Promise<(Token & Record<string, unknown>) | null> {
  const a = address.startsWith("0x") ? address.toLowerCase() : address;
  return (await db.token.findFirst({ where: { address: a, ...(chain ? { chain } : {}) }, ...(include ? { include } : {}) })) as (Token & Record<string, unknown>) | null;
}

/** Native balances of every linked wallet: Solana wallets on Solana, EVM wallets on every EVM chain. */
export async function walletBalances(userId: string) {
  const wallets = await db.wallet.findMany({ where: { userId }, orderBy: { createdAt: "desc" } });
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
  const where: Prisma.TokenWhereInput = {};
  if (query.q) {
    where.OR = [
      { symbol: { contains: query.q, mode: "insensitive" } },
      { name: { contains: query.q, mode: "insensitive" } },
      { address: { startsWith: query.q } },
    ];
  }
  where.marketCapUsd = { gte: query.minMcap, lte: query.maxMcap };
  if (query.minLiq !== undefined) where.liquidityUsd = { gte: query.minLiq };
  if (query.minVol !== undefined) where.volume24hUsd = { gte: query.minVol };
  if (query.risk) {
    const levels = query.risk.split(",").filter((r): r is RiskLevel => ["LOWER", "MODERATE", "HIGH", "CRITICAL"].includes(r));
    if (levels.length) where.riskLevel = { in: levels };
  }
  if (query.dex) where.dex = { equals: query.dex, mode: "insensitive" };
  if (query.chain) where.chain = query.chain;
  if (query.passing === "true") where.passedFilters = true;
  if (query.signal === "BUY" || query.signal === "WATCH") where.signals = { some: { status: "ACTIVE", type: query.signal as SignalType } };
  if (query.signal === "ANY") where.signals = { some: { status: "ACTIVE", type: { in: ["BUY", "WATCH"] } } };
  if (query.signal === "NONE") where.signals = { none: { status: "ACTIVE" } };

  const [total, rows] = await Promise.all([
    db.token.count({ where }),
    db.token.findMany({
      where,
      orderBy: [{ [query.sort]: query.dir } as Prisma.TokenOrderByWithRelationInput, { id: "asc" }],
      skip: (query.page - 1) * query.pageSize,
      take: query.pageSize,
      include: { signals: { where: { status: "ACTIVE" }, orderBy: { createdAt: "desc" }, take: 1, select: { id: true, type: true, score: true } } },
    }),
  ]);
  return { total, page: query.page, pageSize: query.pageSize, pages: Math.max(1, Math.ceil(total / query.pageSize)), rows };
}

export async function listSignals(opts: { page: number; pageSize: number; type?: string; risk?: string; q?: string; sort?: string; minScore?: number; activeOnly?: boolean; minMcap?: number; maxMcap?: number; dex?: string }) {
  const where: Prisma.SignalWhereInput = {};
  if (opts.activeOnly !== false) where.status = "ACTIVE";
  if (opts.type === "BUY" || opts.type === "WATCH") where.type = opts.type;
  if (opts.minScore) where.score = { gte: opts.minScore };
  const tokenWhere: Prisma.TokenWhereInput = {};
  if (opts.risk) {
    const levels = opts.risk.split(",").filter((r): r is RiskLevel => ["LOWER", "MODERATE", "HIGH", "CRITICAL"].includes(r));
    if (levels.length) where.riskLevel = { in: levels };
  }
  if (opts.q) tokenWhere.OR = [{ symbol: { contains: opts.q, mode: "insensitive" } }, { name: { contains: opts.q, mode: "insensitive" } }];
  if (opts.minMcap !== undefined || opts.maxMcap !== undefined) tokenWhere.marketCapUsd = { gte: opts.minMcap, lte: opts.maxMcap };
  if (opts.dex) tokenWhere.dex = { equals: opts.dex, mode: "insensitive" };
  if (Object.keys(tokenWhere).length) where.token = tokenWhere;
  const orderBy: Prisma.SignalOrderByWithRelationInput = opts.sort === "created" ? { createdAt: "desc" } : { score: "desc" };
  const [total, rows] = await Promise.all([
    db.signal.count({ where }),
    db.signal.findMany({ where, orderBy, skip: (opts.page - 1) * opts.pageSize, take: opts.pageSize, include: { token: true } }),
  ]);
  return { total, pages: Math.max(1, Math.ceil(total / opts.pageSize)), rows };
}

export async function positionViews(userId: string, environment?: Environment, includeClosed = false) {
  const positions = await db.position.findMany({
    where: { userId, ...(environment ? { environment } : {}), ...(includeClosed ? {} : { status: { not: "CLOSED" } }) },
    include: { token: true, signal: { select: { id: true, type: true, score: true, createdAt: true } } },
    orderBy: { openedAt: "desc" },
  });
  return positions.map((p) => {
    const targets = (p.targetsSnapshot as unknown as ProfitTargetConfig[]) ?? [];
    const m = computeMetrics(
      { entryPriceUsd: p.entryPriceUsd, initialAmount: p.initialAmount, amount: p.amount, costBasisUsd: p.costBasisUsd, targetsHit: p.targetsHit },
      p.currentPriceUsd,
      targets,
    );
    return { ...p, targets, metrics: m };
  });
}

export async function portfolio(userId: string, environment: Environment) {
  const settings = await getSettings(userId);
  const [views, state, account, wb] = await Promise.all([
    positionViews(userId, environment),
    capitalState(db, userId, environment),
    db.tradingAccount.findUnique({ where: { userId_environment: { userId, environment } } }),
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
  const env: Environment = settings.environment === "MANUAL" ? "PAPER" : settings.environment;
  const startOfDay = new Date();
  startOfDay.setHours(0, 0, 0, 0);
  const [pf, todaySignals, activeSignals, tradesToday, recentSignals, positions, recentTrades, bot, workers, tokenCount, passing, events] = await Promise.all([
    portfolio(userId, env),
    db.signal.count({ where: { createdAt: { gte: startOfDay } } }),
    db.signal.count({ where: { status: "ACTIVE" } }),
    db.trade.count({ where: { userId, createdAt: { gte: startOfDay }, status: "CONFIRMED" } }),
    db.signal.findMany({ where: { status: "ACTIVE" }, orderBy: { score: "desc" }, take: 6, include: { token: true } }),
    positionViews(userId, env),
    db.trade.findMany({ where: { userId }, orderBy: { createdAt: "desc" }, take: 6, include: { token: true } }),
    db.bot.findUnique({ where: { userId } }),
    workerStatuses(),
    db.token.count(),
    db.token.count({ where: { passedFilters: true } }),
    db.systemEvent.findMany({ orderBy: { ts: "desc" }, take: 8 }),
  ]);
  const market = await db.token.aggregate({ where: { passedFilters: true }, _avg: { change1h: true, buySellRatio: true }, _sum: { volume24hUsd: true } });
  return { settings, env, pf, todaySignals, activeSignals, tradesToday, recentSignals, positions: positions.slice(0, 6), recentTrades, bot, workers, tokenCount, passing, events, market };
}

export async function botOverview(userId: string) {
  const settings = await getSettings(userId);
  const env: Environment = settings.environment === "MANUAL" ? "PAPER" : settings.environment;
  const startOfDay = new Date();
  startOfDay.setHours(0, 0, 0, 0);
  const [bot, pf, tradesToday, runs, events, evaluatedAgg] = await Promise.all([
    db.bot.findUnique({ where: { userId } }),
    portfolio(userId, env),
    db.trade.count({ where: { userId, createdAt: { gte: startOfDay }, status: "CONFIRMED" } }),
    db.botRun.findMany({ where: { bot: { userId } }, orderBy: { startedAt: "desc" }, take: 10 }),
    db.systemEvent.findMany({ where: { OR: [{ userId }, { source: "bot" }], type: { in: ["BOT_STARTED", "BOT_PAUSED", "BOT_STOPPED", "TRADE_REQUESTED", "TRADE_EXECUTED", "TRADE_FAILED", "TRADE_SKIPPED", "POSITION_OPENED", "PROFIT_TAKEN", "EMERGENCY_WARNING", "EMERGENCY_EXIT"] } }, orderBy: { ts: "desc" }, take: 25 }),
    db.botRun.aggregate({ where: { bot: { userId } }, _sum: { signalsEvaluated: true, tradesExecuted: true } }),
  ]);
  return { settings, env, bot, pf, tradesToday, runs, events, totals: evaluatedAgg._sum };
}
