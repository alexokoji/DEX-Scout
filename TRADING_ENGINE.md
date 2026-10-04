# Trading engine

## Signal -> trade
1. Signal engine emits BUY/WATCH from an `Analysis` (score, safety, trend). Tokens with critical safety issues never get signals.
2. **Manual**: `POST /api/trades/quote` (read-only) -> `/prepare` (server validates, stores a PREPARED trade, 60s TTL) -> `/execute` (id only; amounts/prices come from the stored trade).
3. **Auto**: `bot.ts` walks active BUY signals by score: user filters, re-weighted score, capital allocation, fresh analysis, quote, `validateEntry(automatic)`, sell simulation, then queues the trade for wallet approval.

## Validation (`core/trading/validation.ts`)
Quote expiry, critical safety issues, sell simulation, price impact, slippage cap, min liquidity/volume, non-zero output; automatic entries also need min score and max risk level.

## Capital (`core/trading/capital.ts`)
Capital is the connected wallet's balance — there is no typed-in trading capital. `allocate()` clamps to max position, available capital (the wallet's native balance on the chain being traded, further limited by the optional max-deployed cap) and open-position slots; rejects below min position. An unknown balance (no wallet linked, RPC down) is not treated as zero. Runs inside `withUserLock` (a real MongoDB multi-document transaction, auto-retried on conflict) so concurrent workers cannot over-allocate.

## Profit taking (`core/trading/targets.ts`)
Targets are snapshotted on the position when opened. Single (+10% sell 100%) or multi (+8/+15/+25 sell 25% each, +40% sell the rest). Each target sells a share of the **initial** amount; the last sells the remainder. Gaps across several targets fire each in order. Only price **gain** is evaluated.

## No stop loss
There is no code path that sells because a position is negative. `assessPosition` deliberately has no price/PnL input. A losing position is `OPEN` (health `HOLD`/`MONITOR`/`WARNING` informs, never sells).

## Emergency protection (separate, opt-in)
Triggers only on: token untradeable/no market data, pool inactive, sell simulation failing, liquidity down >= threshold since entry (default 70%), other critical security condition, extreme exit price impact (>=40%). With *Emergency detection* on you get warnings; with *Allow automatic emergency exit* on a full exit is queued for wallet approval.
Max position age only closes positions that are **in profit**; losers are held with an event note.

## Position status
`OPEN`, `TARGET_1..3`, `PROFITABLE`, `EMERGENCY`, `CLOSED`. Health: `HOLD`, `MONITOR`, `WARNING`, `EMERGENCY`.

## Backtesting
`core/strategy/engine.ts` replays bars through the same target logic, reporting P/L, drawdown, win rate, holding period and capital utilisation. It does not prove future profitability.

## Live path
Every trade is LIVE — there is no simulated/paper mode. `prepareTrade` builds an unsigned transaction (Jupiter on Solana, 0x on EVM); the user's wallet signs and sends; `/execute` records the signature; `reconcileLiveTrade` follows it on-chain and only then creates/updates the Position. The bot cannot sign, so it holds no withdrawal authority. Live position exits are queued the same way.