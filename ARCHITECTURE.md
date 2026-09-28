# Architecture

```
Frontend (App Router pages, client islands for chart / trade panel / wallet)
        v
Route Handlers (/api/*, protectedRoute wrapper: auth, rate limit, Zod, error mapping)
        v
Services (src/services)  - DB-aware orchestration: scanner, analysis, signals, trading, positionMonitor, bot, settings, queries
        v
Core engines (src/core)  - pure, framework-free, unit-tested
   scanner/filter  analysis/{indicators,market,onchain,safety,scoring,pipeline}
   signals/engine  trading/{targets,positions,capital,validation,emergency,paperBroker,quoteMath}  strategy/engine
        v
Provider abstractions (src/core/providers)
   TokenDataProvider  DexAdapter  ChainAdapter(+WalletProvider)  AiProvider  Price/LiquidityProvider
   mock/*  (deterministic simulated market)      solana/* (DexScreener, GeckoTerminal, Jupiter, Solana RPC)
```

## Workers (src/workers)
| Worker | Job |
|---|---|
| scanner-worker | discover tokens, apply filters (union of all users' filters), persist tokens/metrics/pools |
| analysis-worker | safety + market + on-chain analysis + opportunity score for every passing token |
| signal-worker | deterministic signal generation (uncapped), expiry, AI interpretation |
| position-monitor-worker | re-analyse open positions, health status, profit targets, emergency handling |
| trade-executor-worker | per-user bot cycle, LIVE trade reconciliation, stale trade expiry |

They share only the database (heartbeats in `WorkerState`), so they can run in one process (`npm run workers`), separately, or behind a queue.

## Chains
`src/core/chains.ts` is the single source of chain metadata (family, native symbol, explorer, RPC env, DexScreener/GeckoTerminal slugs). Two families are implemented: `svm` (Solana: Jupiter + Solana RPC) and `evm` (Ethereum, Base, BNB Chain, Arbitrum, Polygon: 0x + JSON-RPC via viem). `DexScreenerDataProvider` serves every chain with per-family on-chain handlers; `RoutingDexAdapter` dispatches quotes/transactions by chain family.

**Adding an EVM chain** = one entry in `CHAINS` (+ `CHAIN_IDS`, `ChainId`). **Adding a new family** = implement `ChainAdapter`, an on-chain handler and a `DexAdapter`, then register them in `providers/registry.ts`.

Wallets are stored per address family (`solana` | `evm`): one verified EVM address covers all EVM chains. Token addresses are stored per chain (EVM lower-cased) and every trade, position and quote carries its chain.

## Key decisions
- Pipeline stages are persisted (`Token.stage`: DISCOVERED -> SCANNED -> SAFETY_CHECK -> ANALYZED -> QUALIFIED -> SIGNAL_GENERATED).
- The final execution-eligibility decision is always deterministic (`validateEntry`), never AI.
- The mock market is a pure function of (token index, minute) so server and workers agree without shared state.
- Session auth is a signed JWT in an httpOnly cookie (bcrypt passwords) rather than Auth.js, to keep the auth surface small and dependency-light.