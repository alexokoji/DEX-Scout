import { db } from "@/lib/db";

/**
 * Cross-instance mutual exclusion for background jobs. Serverless cron invocations can overlap (a slow run, a retry,
 * two regions), so each job takes a short database lease and skips the run if another instance still holds it.
 * The lease expires on its own, so a crashed invocation never blocks the job forever.
 */
export async function withLease<T>(name: string, ttlSec: number, fn: () => Promise<T>): Promise<{ ran: true; result: T } | { ran: false }> {
  const key = `lease:${name}`;
  const rows = await db.$queryRaw<{ name: string }[]>`
    INSERT INTO "WorkerState" ("name", "leaseUntil", "updatedAt")
    VALUES (${key}, now() + make_interval(secs => ${ttlSec}::double precision), now())
    ON CONFLICT ("name") DO UPDATE SET "leaseUntil" = now() + make_interval(secs => ${ttlSec}::double precision), "updatedAt" = now()
    WHERE "WorkerState"."leaseUntil" IS NULL OR "WorkerState"."leaseUntil" < now()
    RETURNING "name"`;
  if (rows.length === 0) return { ran: false };
  try {
    return { ran: true, result: await fn() };
  } finally {
    await db.$executeRaw`UPDATE "WorkerState" SET "leaseUntil" = NULL, "updatedAt" = now() WHERE "name" = ${key}`;
  }
}
