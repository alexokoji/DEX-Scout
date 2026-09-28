import { PrismaClient } from "@prisma/client";

const g = globalThis as unknown as { prisma?: PrismaClient };

export const db: PrismaClient = g.prisma ?? new PrismaClient({ log: ["error"] });
if (process.env.NODE_ENV !== "production") g.prisma = db;

export type Tx = Parameters<Parameters<PrismaClient["$transaction"]>[0]>[0];

/** Serialise concurrent work for one user (capital checks) using a transaction-scoped Postgres advisory lock. */
export async function withUserLock<T>(userId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return db.$transaction(
    async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${userId}))`;
      return fn(tx);
    },
    { timeout: 20_000, maxWait: 20_000 },
  );
}
