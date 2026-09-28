# Setup

## Requirements
Node.js 20+ (developed on 24), npm. MongoDB is optional locally (an embedded single-node replica set is bundled for development).

## Local, mock mode
```bash
npm install
cp .env.example .env      # Windows: copy .env.example .env
npm run dev
```
Demo login: **Continue with demo account** (or `demo@dexscout.dev` / `demo-pass-123`, created by the seed script; mock mode only).

## MongoDB
- **Embedded (default dev):** `MONGODB_URI=mongodb://127.0.0.1:27117/dexscout?replicaSet=rs0`. Data lives in `.data/mongo`. It's a real `mongod` binary (via `mongodb-memory-server`) run as a single-node replica set — required because capital-safety locking uses multi-document transactions, which only work on a replica set, never a plain standalone `mongod`.
- **Your own server / Atlas:** set `MONGODB_URI` to a real replica set's connection string (Atlas's free tier is one), then `npm run db:index` to create indexes. `npm run dev` skips the embedded server when the URI isn't `127.0.0.1:27117`.
- No migrations to run — Mongo has none; `db:index`/`vercel-build` just (re)create indexes, which is idempotent.

## Solana RPC
Set `SOLANA_RPC_URL` (and optionally `SOLANA_WS_URL`) to a provider such as Helius/Triton/QuickNode. The RPC key stays server-side. For wallet transaction sending in the browser set `NEXT_PUBLIC_SOLANA_RPC_URL` to a domain-restricted key (or the public endpoint).

## Market data
Real mode (`MOCK_PROVIDER=false`) uses DexScreener (discovery, pairs) and GeckoTerminal (OHLCV) - no key required, both rate limited. `MARKET_DATA_URL` / `MARKET_DATA_API_KEY` let you point at a paid provider. DexScreener has no holder counts, so holders are reported as *unknown* (filters do not penalise unknown holders). Implement `TokenDataProvider` (`src/core/providers/interfaces.ts`) for Birdeye/Helius/etc. and register it in `src/core/providers/registry.ts`.

## EVM chains
Ethereum, Base, BNB Chain, Arbitrum and Polygon share one EVM adapter. Optional RPC overrides: `ETHEREUM_RPC_URL`, `BASE_RPC_URL`, `BSC_RPC_URL`, `ARBITRUM_RPC_URL`, `POLYGON_RPC_URL` (public defaults are used when blank - use a keyed provider in production). LIVE EVM swaps use the 0x Swap API and need `ZEROX_API_KEY`. Enable or disable chains per user under Settings -> Trading -> Chains to scan.

Optional `BIRDEYE_API_KEY` adds holder counts/growth for every chain in real-data mode.

## DEX aggregators
Solana: Jupiter via `DEX_PROVIDER_URL` (+ `DEX_PROVIDER_API_KEY`). EVM: 0x. Both only ever build **unsigned** transactions.

## AI
Set `AI_API_KEY` (Anthropic) and optionally `AI_MODEL`. Without a key a deterministic rules-based summariser fills the same JSON schema and is labelled "rules-based-summary" in the UI. AI output is Zod-validated and display-only.

## Workers
`npm run dev` runs them. In production run `npm run workers` (or each `worker:*` separately) as long-lived processes independent of the web server, or drive the equivalent `/api/cron/*` routes from an external scheduler on Vercel (see VERCEL.md). Each worker exposes `run()` cycles that can be wrapped by BullMQ/SQS consumers.

## Paper trading
Set Settings -> Trading -> environment `PAPER`, enable Auto trading, then press **Start bot** on the Bot page. Manual paper trades use the Paper venue on any token page.

## Enabling live trading
Requires **all** of: `MOCK_PROVIDER=false`, `LIVE_TRADING_ENABLED=true`, a real RPC + aggregator, a wallet linked (signature-verified) on the Wallet page. Then choose the `LIVE` environment/venue. Every live transaction is signed in your wallet; the bot only queues unsigned transactions for approval.

## Multi-instance rate limiting
Set `UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN` to share rate limits across server instances; without them an in-memory limiter is used.

## Production
`npm run build && npm start`, set a strong `AUTH_SECRET`, use a managed MongoDB replica set (e.g. Atlas), run workers separately, put the app behind HTTPS. Replace the in-memory rate limiter (`src/lib/rateLimit.ts`) with Redis for multi-instance deployments.
