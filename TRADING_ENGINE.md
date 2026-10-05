# Trading engine

## Signal -> trade
1. Signal engine emits BUY/WATCH from an `Analysis` (score, safety, trend). Tokens with critical safety issues never get signals.
2. **Manual**: `POST /api/trades/quote` (read-only) -> `/prepare` (server validates, stores a PREPARED trade, 60s TTL) -> `/execute` (id only; amounts/prices come from the stored trade).
3. **Auto**: `bot.ts` walks active BUY signals by score: user filters, re-weighted score, capital allocation, fresh analysis, quote, `validateEntry(automatic)`, sell simulation, then queues the trade for wallet approval.

## Validation (`core/trading/validation.ts`)
Quote expiry, critical safety issues, sell simulation, price impact, slippage cap, min liquidity/volume, non-zero output; automatic entries also need min score and max risk level.

## Capital (`core/trading/capital.ts`)
Capital is the connected wallet's balance — there is no typed-in trading capital. `allocate()` clamps to max position, available capital (the wallet's native balance on the chain being traded, further limited by the optional max-deployed cap) and open-position slots; rejects below min position. An unknown balance (no wallet linked, RPC down) is not treated as zero.

**Fees come from the chain, not from constants.** The amount kept back from a wallet for fees is measured on-chain for that wallet and token (`ChainAdapter.estimateSwapReserve`). Solana: the base fee for a one-signature message (`getFeeForMessage`), the going priority fee (75th percentile of `getRecentPrioritizationFees`, converted for a swap's compute budget and capped; a number typed in the trade panel is only a cap, blank = automatic), and the token-account deposit from `getMinimumBalanceForRentExemption(165)` (currently 1,488,440 lamports; the deposit is skipped when the wallet already holds the token, and a temporary wrapped-SOL account needs the same amount for the instant of the swap). EVM: the chain's current gas price (`eth_gasPrice`) x a typical swap's gas units, with a margin for it moving. Quotes use the same figures (EVM: the aggregator's own gas figure first). If the fees can't be read, nothing is held back and the message says so: the swap dry-run before the wallet opens gives the exact answer. SOL and every other native price is read from the market, with no hard-coded fallback. Runs inside `withUserLock` (a real MongoDB multi-document transaction, auto-retried on conflict) so concurrent workers cannot over-allocate.

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
## Notifications
Everything is recorded in the in-app bell (header; also a toast and, if allowed, a browser notification while the app is open) and pushed to the user's optional free channels — an ntfy.sh topic and/or a Discord webhook (Settings → Notifications). Hosts are fixed server-side, so a saved value can't make the server call an arbitrary URL. Delivery never throws into the trade flow. Wording lives in `services/notificationMessages.ts`.

| Category (switchable) | Events |
|---|---|
| Waiting for your signature | a buy the bot queued (`prepareTrade` AUTO_ENTRY); a target / emergency / max-age sell (`prepareLiveSell`); a bot-queued trade that expired unsigned (`expirePreparedTrades`) |
| Trade results | a buy or sell confirmed on-chain (with realised P/L on sells); a trade that failed, timed out or didn't match the expected swap (`reconcileLiveTrade`) |
| Position alerts | a position's health turning WARNING or EMERGENCY (`monitorPosition`) |
| System problems | no scan for 20 minutes (`checkScannerHealth`, run by the monitor job so it works when the scan job is the thing that died; sent to users with a linked wallet) |

Repeats are suppressed per key (a sell that keeps re-queuing, a flapping position, the same token queued again, the scanner outage) with a reminder window of 30 min–6 h. Emergencies go to ntfy at urgent priority. Hand-made buys/sells you sign right away don't notify. Old notifications are pruned after 30 days.

## Auto-sell (sell by itself when a target is reached)
The bot never holds keys, so it cannot sell for you. What it can do is prepare the sells in advance and let a keeper network execute them on-chain. When a buy confirms, `suggestAutoSells` prepares one limit sell per remaining profit target (the same amounts the manual target logic would sell) and notifies you. On the Positions page one wallet interaction **arms** them; from then on each sells on-chain when its price is reached, even if you're away. Nothing sells by itself until you arm it, and you can cancel at any time.

| Venue | Chains | How it is armed | Notes |
|---|---|---|---|
| CoW Protocol (keyless) | Ethereum, Base, Arbitrum, BNB, Polygon, Avalanche, Linea, Ink | one exact-amount token approval (only if the allowance is short) + one gasless EIP-712 signature per order | pays the chain's native currency to your wallet; orders last 14 days; fill-or-nothing; small orders may not fill on Ethereum mainnet (gas) |
| KyberSwap limit orders (keyless) | Optimism, Unichain, Sonic, Berachain, Monad, HyperEVM, Robinhood (also available on the chains above, where CoW is preferred) | one exact-amount token approval to Kyber's order contract + one gasless EIP-712 signature per order | you receive the chain's WRAPPED coin (WETH, WBNB, ...), which you can unwrap; orders last 14 days; Kyber chooses each order's salt, so it is stored and posted back unchanged; the order's id may not be returned at creation, so it is found by matching the maker's listing |
| Jupiter trigger orders v1 (keyless on lite-api) | Solana | one transaction per order (each moves its tokens into Jupiter's escrow) | min order about $5, so small positions are merged into fewer, larger sells at the earlier target; Jupiter keeps about 0.8% (the limit is grossed up so you net the target); orders stay until filled or cancelled |

**Chains without any keyless limit-order venue: Scroll, Mantle, Blast, World Chain and Abstract** (none of CoW, Kyber or Jupiter serves them; they are also the chains that need a 0x key to swap at all). There, target sells are queued for you to sign, as before. Making them fully automatic would need a custom on-chain order contract (deployed per chain and audited) or handing the app signing power, neither of which this app does. Orders are rebuilt on the server from stored data when posted (the browser sends only ids and signatures). The monitor job books fills (`syncAutoSells`: venue state is compared with what is already booked, so partial fills and repeated syncs never double-count), records a CONFIRMED sell in the ledger, and notifies **Profit taken: SYMBOL +X%** with dollars and the overall result when a position closes. While an order covers a target the manual "sign this sell" flow skips it; uncovered targets still queue as before. Orders that expire, are cancelled elsewhere, or never land (Solana: 4 min, CoW: 10 min) are closed out with a notification.

Verified against the live services while building: CoW accepts our signed order and cancellation formats and its contracts exist on all eight chains; Kyber's order endpoint checks the signature before anything else (a wrong or garbage signature is rejected, ours passes), its cancel format is accepted once the signing domain's chainId is a number, and its listing/fill shapes come from real orders; Jupiter's createOrder works keyless and the history/fill shapes used for booking were taken from real accounts. Not exercised against a real fill of our own orders (that needs a funded wallet), and Jupiter's cancelOrder success response is parsed defensively because no real order was available to cancel.
