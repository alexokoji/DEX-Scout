# Scanner

`services/scanner.ts` -> provider `discover()` -> `core/scanner/filter.ts`.

Collected per token: address, name, symbol, decimals, chain, DEX, pool, price, market cap, FDV, liquidity (+1h ago), volumes (5m/15m/30m/1h/24h), buys/sells (5m/15m/1h), buy/sell ratio, price changes, age (pool creation), holders (+1h ago), pair count.

Filters (defaults, all configurable per user in Settings -> Trading): market cap $1M-$10M, liquidity $100K, 24h volume $50K, holders 300, max age 30d, min 50 tx/1h, max price impact 3% at a $100 probe, DEX and chain lists.

The shared scanner uses the **union envelope** of all users' filters so nobody's band is starved; each user's own filters are re-applied to signals at trade time. Discovered tokens are never truncated: every token is stored (rejected ones as `FILTERED`), and pages paginate server-side.

Chains: Solana, Ethereum, Base, BNB Chain, Arbitrum, Polygon (per-user `Chains to scan` filter; the shared scanner scans the union).

Providers: mock generates ~600 live tokens across all chains (a new launch every 3h on Solana, 6h elsewhere) (archetypes: pumper, steady, sleeper, dumper, rug, honeypot-like trap). Real: DexScreener profiles/boosts -> `tokens/v1/solana/{addresses}` (holders unknown), GeckoTerminal OHLCV.