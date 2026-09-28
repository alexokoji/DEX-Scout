# Database

PostgreSQL + Prisma (`prisma/schema.prisma`). Money/price columns are `Float` (adequate for analytics/paper; move to `Decimal` before handling large real balances).

Models: User, Wallet, TradingAccount (per user+environment), TradingSettings, ProfitTarget, Strategy, Token (+latest denormalised metrics), TokenMetric, PriceSnapshot, VolumeSnapshot, LiquidityPool, TokenSafety, TokenAnalysis, Signal, SignalAnalysis, Bot, BotRun, Position, PositionEvent, Trade, Transaction (real on-chain only), SystemEvent, WorkerState.

Indexes: `Token(chain,address)` unique, `Token(address)`, `Token(marketCapUsd)`, `Token(updatedAt)`, `Token(opportunityScore)`, `Token(passedFilters,marketCapUsd)`, `Signal(createdAt)`, `Signal(score)`, `Signal(status,expiresAt)`, `Position(userId,status)`, `Position(status)`, `Trade(userId,createdAt)`, `Trade(status)`, `SystemEvent(ts)`, `SystemEvent(type,ts)`, time-series `(tokenId, ts)`.

Transactions/locks: capital-affecting writes run in `withUserLock` (`pg_advisory_xact_lock`). Migrations: `npm run db:migrate` (dev) / `npm run db:deploy` (prod). Time-series tables (`TokenMetric`, snapshots, `SystemEvent`) grow continuously - add a retention job or partitioning for production.