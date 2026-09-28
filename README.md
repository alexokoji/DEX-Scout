# DEX Scout

Multi-chain low-cap DEX scanner, signal engine and (paper/live) trading platform. Supports **Solana, Ethereum, Base, BNB Chain, Arbitrum and Polygon**; chain metadata lives in one file (`src/core/chains.ts`) so more chains are additive.

- **Scanner** continuously discovers tokens (default band **$1M-$10M market cap**, fully configurable, no cap on results).
- **Safety + market + on-chain analysis** produce a 0-100 *opportunity score* (an analytical ranking, **not** a probability of profit) and lower/moderate/high/critical **risk levels** (never "safe").
- **Signals** (BUY / WATCH) with entry zone, three targets, reasons, warnings, expiry and a Zod-validated AI interpretation.
- **Wallets**: Solana (Phantom, Solflare, Backpack via Wallet Standard) and EVM (MetaMask, Rabby, Coinbase Wallet, any injected wallet) - both signature-verified, non-custodial.
- **Manual mode**: browse signals, charts, analysis and trade from the token page.
- **Auto mode**: a bot executes rule-approved BUY signals within server-enforced capital limits, monitors positions and **takes profit at configured targets. There is no stop loss.** Optional *emergency protection* only reacts to catastrophic conditions.
- **Environments**: `MANUAL` (signals only), `PAPER` (simulated fills, fees, slippage, failures), `LIVE` (real swaps, wallet-signed, off by default). Every simulated item is labelled `PAPER`/`MOCK`.

## Quick start (no external accounts needed)

```bash
npm install
npm run dev
```

Open http://localhost:3000 and choose **Continue with demo account**. `npm run dev` will:
1. start an embedded local PostgreSQL (port 5433) if `DATABASE_URL` points there,
2. apply migrations and seed the demo user,
3. start the background workers (scanner, analysis, signals, position monitor, trade executor),
4. start Next.js.

`.env` (copy from `.env.example`) ships with `MOCK_PROVIDER=true`, so everything is simulated and runs offline.

## Scripts

| Script | Purpose |
|---|---|
| `npm run dev` | DB + migrations + workers + Next.js |
| `npm run dev:next` | Next.js only |
| `npm run workers` / `worker:scanner`, `worker:analysis`, `worker:signal`, `worker:monitor`, `worker:executor` | Run workers (all or individually) |
| `npm run db:start` | Embedded dev PostgreSQL only |
| `npm run db:migrate` / `db:deploy` | Create / apply migrations |
| `npm test` | Unit + integration tests (integration needs the DB) |
| `npm run typecheck`, `npm run lint`, `npm run build` | Quality gates |
| `npm run smoke` | One scan -> analysis -> signal pass with a printed summary |

## Documentation

[SETUP](SETUP.md) · [ARCHITECTURE](ARCHITECTURE.md) · [TRADING_ENGINE](TRADING_ENGINE.md) · [SCANNER](SCANNER.md) · [DATABASE](DATABASE.md) · [SECURITY](SECURITY.md)

## Important disclaimers

Low-cap tokens are extremely volatile and can go to zero. Scores, risk levels, AI text and backtests are analytical aids, not advice or guarantees. Live trading with real funds is disabled by default; enable it only after paper-trading and reviewing SECURITY.md.