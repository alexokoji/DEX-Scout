import { collections } from "@/lib/db";
import { pruneNotifications } from "./notifications";
import { logEvent } from "@/lib/events";

const DAY = 86_400_000;

/** Retention for continuously growing time-series collections. Safe to call repeatedly. */
export async function pruneOldData(now = new Date()) {
  const ago = (d: number) => new Date(now.getTime() - d * DAY);
  const [tokenMetrics, priceSnapshots, volumeSnapshots, systemEvents, botRuns, trades] = await Promise.all([
    collections.tokenMetrics(),
    collections.priceSnapshots(),
    collections.volumeSnapshots(),
    collections.systemEvents(),
    collections.botRuns(),
    collections.trades(),
  ]);
  const [metrics, prices, volumes, debugEvents, events, runs, oldTrades] = await Promise.all([
    tokenMetrics.deleteMany({ ts: { $lt: ago(7) } }),
    priceSnapshots.deleteMany({ ts: { $lt: ago(7) } }),
    volumeSnapshots.deleteMany({ ts: { $lt: ago(7) } }),
    systemEvents.deleteMany({ level: "DEBUG", ts: { $lt: ago(2) } }),
    systemEvents.deleteMany({ ts: { $lt: ago(30) } }),
    botRuns.deleteMany({ startedAt: { $lt: ago(14) }, tradesExecuted: 0 }),
    trades.deleteMany({ status: { $in: ["EXPIRED", "CANCELLED"] }, createdAt: { $lt: ago(14) } }),
  ]);
  const oldNotifications = await pruneNotifications(30);
  const total = oldNotifications + metrics.deletedCount + prices.deletedCount + volumes.deletedCount + debugEvents.deletedCount + events.deletedCount + runs.deletedCount + oldTrades.deletedCount;
  if (total > 0) await logEvent({ type: "SCANNER_COMPLETED", source: "maintenance", level: "DEBUG", message: `Retention pruned ${total} rows`, data: { metrics: metrics.deletedCount, prices: prices.deletedCount, volumes: volumes.deletedCount, events: events.deletedCount + debugEvents.deletedCount } });
  return total;
}
