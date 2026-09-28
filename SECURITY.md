# Security

- **No keys, ever.** Only public addresses are stored. Wallet linking uses a server-issued, JWT-bound challenge signed with `signMessage` (ed25519 verified server-side); the signature cannot move funds.
- **No withdrawal authority.** Live transactions (Solana and every EVM chain) are built unsigned and signed in the user's wallet; EVM approvals are exact-amount, not unlimited. The bot can only queue them for approval.
- **Server-side enforcement.** Capital, position count, slippage, price impact, liquidity and risk limits are re-checked on the server from stored settings; execute endpoints accept only ids (+ signature).
- **LIVE gating.** `LIVE_TRADING_ENABLED=true` and `MOCK_PROVIDER=false` are both required; the settings API and trade service refuse LIVE otherwise.
- **AuthN/Z.** httpOnly, SameSite=Lax JWT session; every `/api/*` route (except auth) uses `protectedRoute`, and all queries are scoped to the session user. Passwords: bcrypt. Login/registration are rate limited.
- **Validation.** Zod on every body/query; strict TypeScript.
- **Secrets.** Only `NEXT_PUBLIC_*` values reach the browser. RPC/DEX/AI/market keys are server-only; error messages are sanitised and stack traces never returned.
- **AI.** Output is schema-validated, display-only, never an input to `validateEntry` or execution.
- **Audit.** `SystemEvent` records auth, settings changes, wallet links, trade requests/executions/failures, emergency events.
- **Known limitations.** In-memory rate limiter (single instance); LIVE path is written against public Jupiter/DexScreener/RPC APIs and has not been exercised with real funds in this repo - treat it as untested until you do a small supervised run. Confirmed live trades are inspected on-chain (`inspectTransaction`): the fee payer must equal your linked wallet, and position size/cost use the real token and SOL balance deltas (falling back to the quote if the transaction cannot be parsed). The inspection has not been run against mainnet in this repo; do a small supervised run first. It does not yet verify that the transaction's instructions match the prepared swap.