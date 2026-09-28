import { db } from "@/lib/db";
import { logEvent } from "@/lib/events";

const DAY = 86_400_000;

/** Retention for continuously growing time-series tables. Safe to call repeatedly. */
export async function pruneOldData(now = new Date()) {
  const ago = (d: number) => new Date(now.getTime() - d * DAY);
  const [metrics, prices, volumes, debugEvents, events, runs, trades] = await Promise.all([
    db.tokenMetric.deleteMany({ where: { ts: { lt: ago(7) } } }),
    db.priceSnapshot.deleteMany({ where: { ts: { lt: ago(7) } } }),
    db.volumeSnapshot.deleteMany({ where: { ts: { lt: ago(7) } } }),
    db.systemEvent.deleteMany({ where: { level: "DEBUG", ts: { lt: ago(2) } } }),
    db.systemEvent.deleteMany({ where: { ts: { lt: ago(30) } } }),
    db.botRun.deleteMany({ where: { startedAt: { lt: ago(14) }, tradesExecuted: 0 } }),
    db.trade.deleteMany({ where: { status: { in: ["EXPIRED", "CANCELLED"] }, createdAt: { lt: ago(14) } } }),
  ]);
  const total = metrics.count + prices.count + volumes.count + debugEvents.count + events.count + runs.count + trades.count;
  if (total > 0) await logEvent({ type: "SCANNER_COMPLETED", source: "maintenance", level: "DEBUG", message: `Retention pruned ${total} rows`, data: { metrics: metrics.count, prices: prices.count, volumes: volumes.count, events: events.count + debugEvents.count } });
  return total;
}