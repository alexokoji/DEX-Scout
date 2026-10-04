# Scanner

`services/scanner.ts` -> provider `discover()` -> `core/scanner/filter.ts`.

Collected per token: address, name, symbol, decimals, chain, DEX, pool, price, market cap, FDV, liquidity (+1h ago), volumes (5m/15m/30m/1h/24h), buys/sells (5m/15m/1h), buy/sell ratio, price changes, age (pool creation), holders (+1h ago), pair count.

Filters (defaults, all configurable per user in Settings -> Trading): market cap $250K-$25M, liquidity $20K, 24h volume $10K, holders 50 (unknown counts are not penalised), no age cap, min 15 tx/1h, max price impact 3% at a $100 probe, DEX and chain lists. Discovery blends DexScreener boosts/profiles with GeckoTerminal `trending_pools` (established, liquid tokens) and, every third tick, `new_pools` (brand-new pools). Missing data (no candles, a failed on-chain RPC lookup) scores as *unknown/neutral*, never as a negative finding.

Buy-time rules: hard safety limits (critical issues incl. liquidity < $10K, failed sell simulation, price impact, slippage, capital limits) block every trade. Your own preference minimums (liquidity, volume, score, risk) block only the auto bot; a manual buy is shown them as warnings.

The shared scanner uses the **union envelope** of all users' filters so nobody's band is starved; each user's own filters are re-applied to signals at trade time. Discovered tokens are never truncated: every token is stored (rejected ones as `FILTERED`), and pages paginate server-side.

Chains: Solana plus 20 EVM chains (see `src/core/chains.ts`; per-user `Chains to scan` filter, the shared scanner scans the union). Each tick discovers only the next `SCAN_CHAINS_PER_TICK` (default 6) of them, round-robin from a cursor in `workerStates["scan-cursor"]`, so the cost per tick is constant however many chains are enabled and each chain is revisited every ceil(chains/6) ticks. DexScreener's global boost/profile lists are fetched once per 30s and shared across the chains of a tick.

Providers: mock generates ~600 live tokens across all chains (a new launch every 3h on Solana, 6h elsewhere) (archetypes: pumper, steady, sleeper, dumper, rug, honeypot-like trap). Real: DexScreener profiles/boosts -> `tokens/v1/solana/{addresses}` (holders unknown), GeckoTerminal OHLCV.
Price freshness: discovery only re-reports a token while it is on a trending/boost list, so each scan tick also re-fetches the 60 stalest tokens that pass filters on that tick's chains (DexScreener, 30 per request). Before a buy, the quote's real fill price is compared with the listed price: a manual buy shows a warning past 5% drift, the bot won't buy more than 10% above the listed price, and a queued buy is refused at "Review & sign" if it has risen more than 10% since it was queued. The token page shows how old the listed price is.
