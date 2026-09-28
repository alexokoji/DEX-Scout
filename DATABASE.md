# Database

MongoDB, accessed directly through the official `mongodb` driver — no ORM. `src/lib/db.ts` is the entire data
layer: a cached `MongoClient`, typed collection getters (`src/lib/models.ts` has the document interfaces), an
`ensureIndexes()` function, id generation (`newId()` = `crypto.randomUUID()`, stored as `_id`), and `withUserLock`.
Every document uses a UUID string `_id` (never a driver-generated `ObjectId`); `withId`/`withIds` rename `_id` ->
`id` wherever a document leaves the data layer so the rest of the app just sees `.id` everywhere. Money/price
fields are `number` (adequate for analytics/paper; move to a fixed-point representation before handling large real
balances — native JS numbers, same caveat Postgres `Float` had).

## Collections
User, Wallet, TradingAccount (per user+environment), TradingSettings (profit targets embedded as `targets[]`),
Strategy, Token (safety + analysis embedded as `safety`/`analysis`, always loaded together with the token),
TokenMetric, PriceSnapshot, VolumeSnapshot, LiquidityPool, Signal (its AI analysis embedded as `analysis`), Bot,
BotRun, Position, PositionEvent, Trade (its on-chain transaction embedded as `transaction`; paper trades leave it
`null`), SystemEvent, WorkerState (background-worker heartbeats *and* the short-lived leases serverless cron jobs
take to avoid double-running — see `src/services/lease.ts`).

A handful of 1:1, always-fetched-together relations from a relational design (safety/analysis on a token, a
signal's AI write-up, a trade's on-chain transaction, a settings row's profit targets) are embedded subdocuments
instead of their own collections — the natural Mongo shape, not a translation shortcut. Everything else (positions,
trades, signals, tokens, events) stays a separate collection referenced by id, because it's independently queried,
paginated or grows without bound.

## Indexes
Created by `scripts/ensure-indexes.ts` (`npm run db:index`; Mongo has no migration engine, so this runs on every
`npm run dev` and on every Vercel build instead). Unique: `users.email`, `wallets(chain,address)`,
`tradingAccounts(userId,environment)`, `tradingSettings.userId`, `tokens(chain,address)`,
`liquidityPools(chain,address)`, `trades."transaction.signature"` (sparse — most trades have none). Other indexes:
`tokens(address)`, `tokens(marketCapUsd)`, `tokens(updatedAt)`, `tokens(opportunityScore)`,
`tokens(passedFilters,marketCapUsd)`, `signals(createdAt)`, `signals(score)`, `signals(status,expiresAt)`,
`signals(tokenId,status)`, `positions(userId,status)`, `positions(status)`, `positions(tokenId)`,
`positions(openedAt)`, `trades(userId,createdAt)`, `trades(status)`, `trades(tokenId)`, `systemEvents(ts)`,
`systemEvents(type,ts)`, `systemEvents(userId,ts)`, time-series `(tokenId, ts)` on `tokenMetrics`/`priceSnapshots`/
`volumeSnapshots`.

## Transactions & locking
Capital-affecting writes (opening/closing a position, allocating capital) run inside `withUserLock`
(`src/lib/db.ts`), which wraps a real multi-document MongoDB **transaction** (`session.withTransaction`, which
retries automatically on transient conflicts) — every read and write the callback makes, passed the `session`,
commits atomically as one unit or not at all. This needs a replica set: MongoDB Atlas always is one; local dev runs
a single-node replica set via `mongodb-memory-server` for the same reason (a plain standalone `mongod` can't run
transactions at all). `src/services/lease.ts` uses a separate, non-transactional acquire-then-release pattern
against `workerStates` for cross-instance job exclusion, since that only needs "did I get the lease first", not
multi-document atomicity.

## Retention
Time-series collections (`tokenMetrics`, `priceSnapshots`, `volumeSnapshots`, `systemEvents`) grow continuously.
`src/services/maintenance.ts` (`pruneOldData`) deletes rows older than 7 days (metrics/snapshots), 2 days (debug
events), 30 days (all events), and stale expired/cancelled trades/bot runs older than 14 days. It runs roughly
hourly from the scanner worker/cron job.
