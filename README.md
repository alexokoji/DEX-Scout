# DEX Scout

Multi-chain low-cap DEX scanner, signal engine and live trading platform. Supports **Solana plus 20 EVM chains** (Ethereum, Base, BNB Chain, Arbitrum, Polygon, Robinhood Chain, Avalanche, Optimism, Unichain, Linea, Sonic, Berachain, HyperEVM, Ink, Mantle, Scroll, Blast, World Chain, Abstract, Monad); chain metadata lives in one file (`src/core/chains.ts`) so more chains are additive, and scanning rotates across them so cost per tick stays flat.

- **Scanner** continuously discovers tokens (default band **$250K-$25M market cap**, fully configurable, no cap on results).
- **Safety + market + on-chain analysis** produce a 0-100 *opportunity score* (an analytical ranking, **not** a probability of profit) and lower/moderate/high/critical **risk levels** (never "safe").
- **Signals** (BUY / WATCH) with entry zone, three targets, reasons, warnings, expiry and a Zod-validated AI interpretation.
- **Wallets**: Solana (Phantom, Solflare, Backpack via Wallet Standard) and EVM (MetaMask, Rabby, Coinbase Wallet, any injected wallet) - both signature-verified, non-custodial. Optional unattended trading uses a separate bot wallet the server holds (see TRADING_ENGINE.md).
- **Manual mode**: browse signals, charts, analysis and trade from the token page.
- **Auto mode**: a bot executes rule-approved BUY signals within server-enforced capital limits, monitors positions and **takes profit at configured targets. There is no stop loss.** Optional *emergency protection* only reacts to catastrophic conditions.
- **Environments**: `MANUAL` (signals only, bot never trades) or `LIVE` (real swaps, wallet-signed, off by default until `LIVE_TRADING_ENABLED=true` with real providers). Mock/simulated data is labelled `MOCK`.

## Quick start (no external accounts needed)

```bash
npm install
npm run dev
```

Open http://localhost:3000 and register an account. `npm run dev` will:
1. start an embedded local MongoDB replica set (port 27117) if `MONGODB_URI` points there,
2. ensure indexes,
3. start the background workers (scanner, analysis, signals, position monitor, trade executor),
4. start Next.js.

`.env` (copy from `.env.example`) ships with `MOCK_PROVIDER=true`, so scanning/analysis/signals run fully offline on synthetic data. There is no demo account and no simulated (paper) trading mode — every trade is LIVE and wallet-signed; LIVE is disabled by default until explicitly enabled with real providers.

## Scripts

| Script | Purpose |
|---|---|
| `npm run dev` | DB + migrations + workers + Next.js |
| `npm run dev:next` | Next.js only |
| `npm run workers` / `worker:scanner`, `worker:analysis`, `worker:signal`, `worker:monitor`, `worker:executor` | Run workers (all or individually) |
| `npm run db:start` | Embedded dev MongoDB only |
| `npm run db:migrate` / `db:deploy` | Create / apply migrations |
| `npm test` | Unit + integration tests (integration needs the DB) |
| `npm run typecheck`, `npm run lint`, `npm run build` | Quality gates |
| `npm run smoke` | One scan -> analysis -> signal pass with a printed summary |

## Documentation

[SETUP](SETUP.md) · [ARCHITECTURE](ARCHITECTURE.md) · [TRADING_ENGINE](TRADING_ENGINE.md) · [SCANNER](SCANNER.md) · [DATABASE](DATABASE.md) · [SECURITY](SECURITY.md)

## Important disclaimers

Low-cap tokens are extremely volatile and can go to zero. Scores, risk levels, AI text and backtests are analytical aids, not advice or guarantees. Live trading with real funds is disabled by default; enable it only after reviewing SECURITY.md.