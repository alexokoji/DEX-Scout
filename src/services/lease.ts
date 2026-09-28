import { collections } from "@/lib/db";

/**
 * Cross-instance mutual exclusion for background jobs. Serverless cron invocations can overlap (a slow run, a retry,
 * two regions), so each job takes a short database lease and skips the run if another instance still holds it.
 * The lease expires on its own, so a crashed invocation never blocks the job forever.
 *
 * Implemented as a plain (non-transactional) two-step acquire against the `workerStates` collection, keyed as
 * `lease:<name>` — deliberately not `findOneAndUpdate` with `upsert: true`, because upserting against a filter
 * that includes `_id` plus an "is it free" condition can race with itself: if the document exists but fails the
 * "free" condition, Mongo sees "no match" and tries to *insert* a duplicate `_id`, which is just a confusing way
 * to fail. Instead: try to acquire an existing free lease; if that matches nothing, try to insert a fresh one and
 * treat a duplicate-key error as "someone else has it" (`ok` below is `true` only once).
 */
export async function withLease<T>(name: string, ttlSec: number, fn: () => Promise<T>): Promise<{ ran: true; result: T } | { ran: false }> {
  const key = `lease:${name}`;
  const states = await collections.workerStates();
  const now = new Date();
  const leaseUntil = new Date(now.getTime() + ttlSec * 1000);

  const acquiredExisting = await states.updateOne(
    { _id: key, $or: [{ leaseUntil: null }, { leaseUntil: { $lt: now } }] },
    { $set: { leaseUntil, updatedAt: now } },
  );
  let acquired = acquiredExisting.modifiedCount === 1;
  if (!acquired) {
    try {
      await states.insertOne({ _id: key, leaseUntil, updatedAt: now, lastRunAt: null, lastError: null, runs: 0, stats: null });
      acquired = true;
    } catch (err) {
      // duplicate key (code 11000) => another instance holds (or just created) this lease; anything else, rethrow
      if (!(err instanceof Error) || !("code" in err) || (err as { code?: number }).code !== 11000) throw err;
    }
  }
  if (!acquired) return { ran: false };

  try {
    return { ran: true, result: await fn() };
  } finally {
    await states.updateOne({ _id: key }, { $set: { leaseUntil: null, updatedAt: new Date() } });
  }
}
