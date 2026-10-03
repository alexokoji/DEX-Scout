# Setup

## Requirements
Node.js 20+ (developed on 24), npm. MongoDB is optional locally (an embedded single-node replica set is bundled for development).

## Local, mock mode
```bash
npm install
cp .env.example .env      # Windows: copy .env.example .env
npm run dev
```
There is no demo account. Register normally at `/register` — mock mode still generates synthetic tokens/signals so there's data to look at.

## MongoDB
- **Embedded (default dev):** `MONGODB_URI=mongodb://127.0.0.1:27117/dexscout?replicaSet=rs0`. Data lives in `.data/mongo`. It's a real `mongod` binary (via `mongodb-memory-server`) run as a single-node replica set — required because capital-safety locking uses multi-document transactions, which only work on a replica set, never a plain standalone `mongod`.
- **Your own server / Atlas:** set `MONGODB_URI` to a real replica set's connection string (Atlas's free tier is one), then `npm run db:index` to create indexes. `npm run dev` skips the embedded server when the URI isn't `127.0.0.1:27117`.
- No migrations to run — Mongo has none; `db:index`/`vercel-build` just (re)create indexes, which is idempotent.

## Solana RPC
Set `SOLANA_RPC_URL` (and optionally `SOLANA_WS_URL`) to a provider such as Helius/Triton/QuickNode. The RPC key stays server-side. For wallet transaction sending in the browser set `NEXT_PUBLIC_SOLANA_RPC_URL` to a domain-restricted key (or the public endpoint).

## Market data
Real mode (`MOCK_PROVIDER=false`) uses DexScreener (discovery, pairs) and GeckoTerminal (OHLCV) - no key required, both rate limited. `MARKET_DATA_URL` / `MARKET_DATA_API_KEY` let you point at a paid provider. DexScreener has no holder counts, so holders are reported as *unknown* (filters do not penalise unknown holders). Implement `TokenDataProvider` (`src/core/providers/interfaces.ts`) for Birdeye/Helius/etc. and register it in `src/core/providers/registry.ts`.

## EVM chains
Every EVM chain shares one adapter: Ethereum, Base, BNB Chain, Arbitrum, Polygon, Robinhood Chain, Avalanche, Optimism, Unichain, Linea, Sonic, Berachain, HyperEVM, Ink, Mantle, Scroll, Blast, World Chain, Abstract and Monad. Optional RPC overrides are named `<CHAIN>_RPC_URL` (`ETHEREUM_RPC_URL`, `AVALANCHE_RPC_URL`, `INK_RPC_URL`, ...); free public endpoints with automatic failover are used when blank. Swaps need no key on the first thirteen; **Ink, Mantle, Scroll, Blast, World Chain, Abstract and Monad have no free aggregator**, so they are scanned and scored but trading there needs a free-tier `ZEROX_API_KEY`. Enable or disable chains per user under Settings -> Trading -> Chains to scan.

Scanning rotates: each scan tick discovers `SCAN_CHAINS_PER_TICK` chains (default 6) from a cursor kept in the database, so adding chains makes each one refresh a little less often instead of making every tick slower (GeckoTerminal is paced at ~1 call / 2.2s, which is what bounds a tick). Adding another chain = one entry in `src/core/chains.ts`.

Optional `BIRDEYE_API_KEY` adds holder counts/growth for every chain in real-data mode.

## DEX aggregators
Solana: Jupiter via `DEX_PROVIDER_URL` (+ `DEX_PROVIDER_API_KEY`). EVM: ParaSwap and KyberSwap (free, no key), with 0x tried first only if `ZEROX_API_KEY` is set. All of them only ever build **unsigned** transactions.

## AI
Set `AI_API_KEY` (Anthropic) and optionally `AI_MODEL`. Without a key a deterministic rules-based summariser fills the same JSON schema and is labelled "rules-based-summary" in the UI. AI output is Zod-validated and display-only.

## Workers
`npm run dev` runs them. In production run `npm run workers` (or each `worker:*` separately) as long-lived processes independent of the web server, or drive the equivalent `/api/cron/*` routes from an external scheduler on Vercel (see VERCEL.md). Each worker exposes `run()` cycles that can be wrapped by BullMQ/SQS consumers.

## Enabling live trading
There is no paper/simulated trading mode — every trade is LIVE. Trading requires **all** of: `MOCK_PROVIDER=false`, `LIVE_TRADING_ENABLED=true`, a real RPC + aggregator, a wallet linked (signature-verified) on the Wallet page. For auto trading, set Settings -> Trading -> environment `LIVE`, enable Auto trading, then press **Start bot** on the Bot page. Every live transaction is signed in your wallet; the bot only queues unsigned transactions for approval.

## Multi-instance rate limiting
Set `UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN` to share rate limits across server instances; without them an in-memory limiter is used.

## Production
`npm run build && npm start`, set a strong `AUTH_SECRET`, use a managed MongoDB replica set (e.g. Atlas), run workers separately, put the app behind HTTPS. Replace the in-memory rate limiter (`src/lib/rateLimit.ts`) with Redis for multi-instance deployments.
