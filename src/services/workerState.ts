import { collections } from "@/lib/db";
import type { Json } from "@/lib/models";

export const WORKERS = ["scanner-worker", "analysis-worker", "signal-worker", "position-monitor-worker", "trade-executor-worker"] as const;
export type WorkerName = (typeof WORKERS)[number];

/** Heartbeat used by the UI to show whether each background worker is alive. */
export async function touchWorker(name: WorkerName | string, error: string | null, stats?: Json): Promise<void> {
  const now = new Date();
  const states = await collections.workerStates();
  const set: Partial<{ lastRunAt: Date; lastError: string | null; updatedAt: Date; stats: Json }> = { lastRunAt: now, lastError: error, updatedAt: now };
  if (stats !== undefined) set.stats = stats;
  await states.updateOne({ _id: name }, { $set: set, $inc: { runs: 1 }, $setOnInsert: { leaseUntil: null } }, { upsert: true });
}

export async function workerStatuses(staleAfterSec = 180) {
  const states = await collections.workerStates();
  const rows = await states.find({ _id: { $in: [...WORKERS] } }).toArray();
  const map = new Map(rows.map((r) => [r._id, r]));
  return WORKERS.map((name) => {
    const r = map.get(name);
    const ageSec = r?.lastRunAt ? (Date.now() - r.lastRunAt.getTime()) / 1000 : null;
    return {
      name,
      lastRunAt: r?.lastRunAt ?? null,
      lastError: r?.lastError ?? null,
      runs: r?.runs ?? 0,
      stats: (r?.stats ?? null) as Record<string, unknown> | null,
      alive: ageSec !== null && ageSec < staleAfterSec,
    };
  });
}
