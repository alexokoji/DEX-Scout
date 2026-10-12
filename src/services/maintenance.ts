import type { Collection, Filter } from "mongodb";
import { collections } from "@/lib/db";
import { pruneNotifications } from "./notifications";
import { logEvent } from "@/lib/events";

const DAY = 86_400_000;

/**
 * How long each kind of data is kept. The scanner writes a lot (every token it sees, every minute), and the database has a fixed size, so
 * only what something still reads is kept, and only as long as it is read:
 *  - price and volume snapshots are written but nothing reads them: a day;
 *  - token metrics feed the holders/liquidity history on a token page (the latest 240 rows): three days;
 *  - liquidity pool records are written but nothing reads them: a week since the pool was last seen;
 *  - tokens the scanner discovered and filtered out are only ever looked at again if they show up again, in which case they are
 *    re-created: kept a week since last scanned, unless something of the user's refers to them (a position, a trade, an auto-sell order,
 *    a signal that is kept);
 *  - signals: three days (a signal expires within hours), unless a position was opened from it;
 *  - system events: debug two days, routine info a week, warnings and errors a month;
 *  - bot runs that traded nothing: two days (the Unattended page shows the latest);
 *  - trades that never happened (expired, cancelled): two weeks; notifications: a month.
 * Positions, trades that happened, settings, wallets and bot wallets are never pruned.
 */
export const RETENTION_DAYS = { priceSnapshots: 1, volumeSnapshots: 1, tokenMetrics: 3, liquidityPools: 7, tokens: 7, signals: 3, debugEvents: 2, infoEvents: 7, otherEvents: 30, idleBotRuns: 2, neverHappenedTrades: 14, notifications: 30 } as const;

export type PruneReport = Record<string, number>;

/** Deletes (or, for a dry run, counts) what matches, in chunks, until nothing is left or the time budget is used. */
async function remove<T extends { _id: string }>(col: Collection<T>, filter: Filter<T>, apply: boolean, deadline: number): Promise<number> {
  if (!apply) return col.countDocuments(filter);
  let total = 0;
  while (Date.now() < deadline) {
    const ids = await col.find(filter, { projection: { _id: 1 }, limit: 5000 }).toArray();
    if (!ids.length) break;
    const r = await col.deleteMany({ _id: { $in: ids.map((d) => d._id) } } as Filter<T>);
    total += r.deletedCount;
    if (ids.length < 5000) break;
  }
  return total;
}

/**
 * Prune what is no longer needed (see RETENTION_DAYS). Safe to call repeatedly. `apply: false` only counts. Stops when `budgetMs` is used
 * (the hourly job has a minute to do everything); what is left is taken off by the next run.
 */
export async function pruneReport(now = new Date(), opts: { apply?: boolean; budgetMs?: number } = {}): Promise<PruneReport> {
  const apply = opts.apply ?? true;
  const deadline = Date.now() + (opts.budgetMs ?? 20_000);
  const ago = (d: number) => new Date(now.getTime() - d * DAY);
  const R = RETENTION_DAYS;
  const c = {
    tokenMetrics: await collections.tokenMetrics(), priceSnapshots: await collections.priceSnapshots(), volumeSnapshots: await collections.volumeSnapshots(),
    liquidityPools: await collections.liquidityPools(), tokens: await collections.tokens(), signals: await collections.signals(), systemEvents: await collections.systemEvents(),
    botRuns: await collections.botRuns(), trades: await collections.trades(), positions: await collections.positions(), autoSellOrders: await collections.autoSellOrders(),
  };
  const out: PruneReport = {};

  out.priceSnapshots = await remove(c.priceSnapshots, { ts: { $lt: ago(R.priceSnapshots) } }, apply, deadline);
  out.volumeSnapshots = await remove(c.volumeSnapshots, { ts: { $lt: ago(R.volumeSnapshots) } }, apply, deadline);
  out.tokenMetrics = await remove(c.tokenMetrics, { ts: { $lt: ago(R.tokenMetrics) } }, apply, deadline);
  out.liquidityPools = await remove(c.liquidityPools, { updatedAt: { $lt: ago(R.liquidityPools) } }, apply, deadline);
  out.debugEvents = await remove(c.systemEvents, { level: "DEBUG", ts: { $lt: ago(R.debugEvents) } }, apply, deadline);
  out.infoEvents = await remove(c.systemEvents, { level: "INFO", ts: { $lt: ago(R.infoEvents) } }, apply, deadline);
  out.otherEvents = await remove(c.systemEvents, { ts: { $lt: ago(R.otherEvents) } }, apply, deadline);
  out.botRuns = await remove(c.botRuns, { startedAt: { $lt: ago(R.idleBotRuns) }, tradesExecuted: 0 }, apply, deadline);
  out.neverHappenedTrades = await remove(c.trades, { status: { $in: ["EXPIRED", "CANCELLED"] }, createdAt: { $lt: ago(R.neverHappenedTrades) } }, apply, deadline);

  // signals: old ones go, except those a position was opened from
  const openedFrom = (await c.positions.find({ sourceSignalId: { $ne: null } }, { projection: { sourceSignalId: 1 } }).toArray()).map((p) => p.sourceSignalId as string);
  out.signals = await remove(c.signals, { createdAt: { $lt: ago(R.signals) }, _id: { $nin: openedFrom } }, apply, deadline);

  // tokens: only the ones nothing refers to (the user's positions, trades, auto-sell orders, signals that are kept)
  const referenced = new Set<string>();
  for (const p of await c.positions.find({}, { projection: { tokenId: 1 } }).toArray()) referenced.add(p.tokenId);
  for (const t of await c.trades.find({}, { projection: { tokenId: 1 } }).toArray()) referenced.add(t.tokenId);
  for (const o of await c.autoSellOrders.find({}, { projection: { tokenId: 1 } }).toArray()) referenced.add(o.tokenId);
  for (const s of await c.signals.find({}, { projection: { tokenId: 1 } }).toArray()) referenced.add(s.tokenId);
  out.tokens = await remove(c.tokens, { lastScannedAt: { $lt: ago(R.tokens) }, _id: { $nin: [...referenced] } }, apply, deadline);

  out.notifications = apply ? await pruneNotifications(R.notifications) : 0;
  return out;
}

/** The scheduled retention run: prune with a time budget, and say how much went. Returns the number of rows removed. */
export async function pruneOldData(now = new Date()): Promise<number> {
  const r = await pruneReport(now, { apply: true });
  const total = Object.values(r).reduce((s, n) => s + n, 0);
  if (total > 0) await logEvent({ type: "SCANNER_COMPLETED", source: "maintenance", level: "DEBUG", message: `Retention pruned ${total} rows`, data: r });
  return total;
}
