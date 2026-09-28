import type { Prisma } from "@prisma/client";
import { db } from "@/lib/db";

export const WORKERS = ["scanner-worker", "analysis-worker", "signal-worker", "position-monitor-worker", "trade-executor-worker"] as const;
export type WorkerName = (typeof WORKERS)[number];

/** Heartbeat used by the UI to show whether each background worker is alive. */
export async function touchWorker(name: WorkerName, error: string | null, stats?: Prisma.InputJsonValue): Promise<void> {
  const now = new Date();
  await db.workerState.upsert({
    where: { name },
    create: { name, lastRunAt: now, lastError: error, runs: 1, stats },
    update: { lastRunAt: now, lastError: error, runs: { increment: 1 }, ...(stats !== undefined ? { stats } : {}) },
  });
}

export async function workerStatuses(staleAfterSec = 180) {
  const rows = await db.workerState.findMany();
  const map = new Map(rows.map((r) => [r.name, r]));
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
