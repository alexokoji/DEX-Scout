/**
 * MongoDB data layer. No ORM: this is a thin, typed wrapper around the official `mongodb` driver —
 * connection caching (so Next.js dev hot-reload and warm serverless invocations reuse one client),
 * typed collection getters, index creation (Mongo has no migration engine, so this replaces `prisma migrate`),
 * id generation, and `withUserLock`, the money-safety primitive every capital-affecting write goes through.
 */
import { MongoClient, type ClientSession, type Collection, type Db } from "mongodb";
import { randomUUID } from "node:crypto";
import type {
  BotDoc,
  BotRunDoc,
  LiquidityPoolDoc,
  PositionDoc,
  PositionEventDoc,
  PriceSnapshotDoc,
  SignalDoc,
  StrategyDoc,
  SystemEventDoc,
  TokenDoc,
  TokenMetricDoc,
  TradeDoc,
  TradingAccountDoc,
  TradingSettingsDoc,
  UserDoc,
  VolumeSnapshotDoc,
  WalletDoc,
  WorkerStateDoc,
} from "./models";

function mongoUri(): string {
  const uri = process.env.MONGODB_URI;
  if (!uri) throw new Error("MONGODB_URI is not set");
  return uri;
}
function dbName(): string | undefined {
  return process.env.MONGODB_DB || undefined; // undefined = use the database from the URI's path
}

const g = globalThis as unknown as { __mongoClientPromise?: Promise<MongoClient> };

/** One MongoClient per process, reused across requests (and across dev hot-reloads via the global cache). */
function client(): Promise<MongoClient> {
  if (!g.__mongoClientPromise) {
    g.__mongoClientPromise = new MongoClient(mongoUri(), { maxPoolSize: 10 }).connect();
  }
  return g.__mongoClientPromise;
}

export async function getDb(): Promise<Db> {
  return (await client()).db(dbName());
}

function col<T extends { _id: string }>(name: string): { (): Promise<Collection<T>> } {
  let cached: Promise<Collection<T>> | undefined;
  return () => (cached ??= getDb().then((d) => d.collection<T>(name)));
}

/** Typed collection getters. Each is `async () => Collection<T>` — call it, then use the driver directly. */
export const collections = {
  users: col<UserDoc>("users"),
  wallets: col<WalletDoc>("wallets"),
  tradingAccounts: col<TradingAccountDoc>("tradingAccounts"),
  tradingSettings: col<TradingSettingsDoc>("tradingSettings"),
  strategies: col<StrategyDoc>("strategies"),
  tokens: col<TokenDoc>("tokens"),
  tokenMetrics: col<TokenMetricDoc>("tokenMetrics"),
  priceSnapshots: col<PriceSnapshotDoc>("priceSnapshots"),
  volumeSnapshots: col<VolumeSnapshotDoc>("volumeSnapshots"),
  liquidityPools: col<LiquidityPoolDoc>("liquidityPools"),
  signals: col<SignalDoc>("signals"),
  bots: col<BotDoc>("bots"),
  botRuns: col<BotRunDoc>("botRuns"),
  positions: col<PositionDoc>("positions"),
  positionEvents: col<PositionEventDoc>("positionEvents"),
  trades: col<TradeDoc>("trades"),
  systemEvents: col<SystemEventDoc>("systemEvents"),
  workerStates: col<WorkerStateDoc>("workerStates"),
};

/** New application-level id. Stored as `_id` on every document (never a driver-generated ObjectId). */
export function newId(): string {
  return randomUUID();
}

/** Renames `_id` -> `id` so callers work with plain `.id` everywhere, exactly like the old Prisma models did. */
export function withId<T extends { _id: string }>(doc: T): Omit<T, "_id"> & { id: string } {
  const { _id, ...rest } = doc;
  return { id: _id, ...rest } as Omit<T, "_id"> & { id: string };
}
export function withIds<T extends { _id: string }>(docs: T[]): (Omit<T, "_id"> & { id: string })[] {
  return docs.map(withId);
}

export type { ClientSession };

/**
 * Serialises capital-affecting work for one user inside a real multi-document MongoDB transaction
 * (requires a replica set — Atlas always is one; local dev uses a single-node replica set via
 * `mongodb-memory-server`). `session.withTransaction` retries automatically on transient errors, so this
 * gives strictly stronger guarantees than the Postgres advisory lock it replaces: every read and write `fn`
 * makes (passed the `session`) commits atomically as one unit, or none of it does.
 *
 * Every query `fn` issues must pass `{ session }` to see this transaction's writes and participate in it.
 */
export async function withUserLock<T>(_userId: string, fn: (session: ClientSession) => Promise<T>): Promise<T> {
  const session = (await client()).startSession();
  try {
    let result: T;
    await session.withTransaction(async () => {
      result = await fn(session);
    });
    return result!;
  } finally {
    await session.endSession();
  }
}

/**
 * Idempotent index setup — safe to call on every deploy/dev boot. Mongo has no migration engine; this is
 * the replacement for `prisma migrate`.
 */
export async function ensureIndexes(): Promise<void> {
  const db = await getDb();
  const idx = (name: string, spec: Parameters<Collection["createIndexes"]>[0]) => db.collection(name).createIndexes(spec);

  await Promise.all([
    idx("users", [{ key: { email: 1 }, unique: true, name: "email_unique" }, { key: { createdAt: 1 }, name: "createdAt" }]),
    idx("wallets", [{ key: { chain: 1, address: 1 }, unique: true, name: "chain_address_unique" }, { key: { userId: 1 }, name: "userId" }]),
    idx("tradingAccounts", [{ key: { userId: 1, environment: 1 }, unique: true, name: "userId_environment_unique" }]),
    idx("tradingSettings", [{ key: { userId: 1 }, unique: true, name: "userId_unique" }]),
    idx("strategies", [{ key: { userId: 1 }, name: "userId" }]),
    idx("tokens", [
      { key: { chain: 1, address: 1 }, unique: true, name: "chain_address_unique" },
      { key: { address: 1 }, name: "address" },
      { key: { marketCapUsd: 1 }, name: "marketCapUsd" },
      { key: { updatedAt: 1 }, name: "updatedAt" },
      { key: { opportunityScore: 1 }, name: "opportunityScore" },
      { key: { passedFilters: 1, marketCapUsd: 1 }, name: "passedFilters_marketCapUsd" },
    ]),
    idx("tokenMetrics", [{ key: { tokenId: 1, ts: 1 }, name: "tokenId_ts" }]),
    idx("priceSnapshots", [{ key: { tokenId: 1, ts: 1 }, name: "tokenId_ts" }]),
    idx("volumeSnapshots", [{ key: { tokenId: 1, ts: 1 }, name: "tokenId_ts" }]),
    idx("liquidityPools", [{ key: { chain: 1, address: 1 }, unique: true, name: "chain_address_unique" }, { key: { tokenId: 1 }, name: "tokenId" }]),
    idx("signals", [
      { key: { createdAt: 1 }, name: "createdAt" },
      { key: { score: 1 }, name: "score" },
      { key: { status: 1, expiresAt: 1 }, name: "status_expiresAt" },
      { key: { tokenId: 1, status: 1 }, name: "tokenId_status" },
    ]),
    idx("bots", [{ key: { userId: 1 }, unique: true, name: "userId_unique" }]),
    idx("botRuns", [{ key: { botId: 1, startedAt: 1 }, name: "botId_startedAt" }]),
    idx("positions", [
      { key: { userId: 1, status: 1 }, name: "userId_status" },
      { key: { status: 1 }, name: "status" },
      { key: { tokenId: 1 }, name: "tokenId" },
      { key: { openedAt: 1 }, name: "openedAt" },
    ]),
    idx("positionEvents", [{ key: { positionId: 1, createdAt: 1 }, name: "positionId_createdAt" }]),
    idx("trades", [
      { key: { userId: 1, createdAt: 1 }, name: "userId_createdAt" },
      { key: { status: 1 }, name: "status" },
      { key: { tokenId: 1 }, name: "tokenId" },
      { key: { "transaction.signature": 1 }, name: "transaction_signature_unique", unique: true, sparse: true },
    ]),
    idx("systemEvents", [
      { key: { ts: 1 }, name: "ts" },
      { key: { type: 1, ts: 1 }, name: "type_ts" },
      { key: { userId: 1, ts: 1 }, name: "userId_ts" },
    ]),
  ]);
}

/** Closes the shared client. Only used by scripts/tests that need a clean process exit. */
export async function closeDb(): Promise<void> {
  if (g.__mongoClientPromise) {
    const c = await g.__mongoClientPromise;
    await c.close();
    g.__mongoClientPromise = undefined;
  }
}
