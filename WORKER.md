# Running the bot on a machine of your own (instead of Vercel's scheduler)

The website can stay on Vercel's free plan; what costs Vercel's usage limits is the scheduler calling the app every minute for the scanner,
the position monitor and the bot. The same work can run as one always-on process (`npm run workers`) on any machine that stays on. Vercel
then only serves pages, which uses almost nothing.

What you need: a machine that is on all the time and can reach the internet. Free: an Oracle Cloud "Always Free" VM (needs a card to
verify your identity, and capacity isn't always available). Cheap: any small VPS (about $4–5 a month). Or a PC at home that never sleeps.
512 MB–1 GB of memory is enough.

**The bot wallet's key lives on this machine and in your database: anyone who can read both can sign for the bot wallets.** Use SSH keys
only, no password logins, keep `.env.worker` readable by you alone (`chmod 600 .env.worker`), and only fund the bot wallets with what you
accept to lose.

## Set it up (Ubuntu/Debian VM)

1. Install Docker: `curl -fsSL https://get.docker.com | sh`
2. Get the code: `git clone https://github.com/alexokoji/DEX-Scout && cd DEX-Scout`
3. Create `.env.worker` (see below), then `chmod 600 .env.worker`.
4. Start: `docker compose up -d --build`
5. Watch: `docker compose logs -f`. Within a minute the Bot page in the app should show the workers alive and "last run" moving.
6. **Switch off the scheduler** so two bots aren't running: from your own computer, with `APP_URL`, `CRON_SECRET` and `CRONJOB_ORG_API_KEY` in
   `.env`: `node scripts/setup-cronjob-org.mjs --pause`. (To go back to the scheduler: `node scripts/setup-cronjob-org.mjs`, and stop the
   worker with `docker compose down`. Never both.)

Update after a `git push`: on the machine, `git pull && docker compose up -d --build`.

## `.env.worker`

The worker needs the same settings as the website, because it does the trading and holds no state of its own:

```
MONGODB_URI=...                # the same database
AUTH_SECRET=...                # the same value as the website's
MOCK_PROVIDER=false
LIVE_TRADING_ENABLED=true
BOT_WALLET_KEY=...             # the SAME key the bot wallets were created with, or they can't be opened
SOLANA_RPC_URL=...
ETHEREUM_RPC_URL=...           # and the other <CHAIN>_RPC_URL values you use
ZEROX_API_KEY=...
DEX_PROVIDER_URL=...
DEX_PROVIDER_API_KEY=...
MARKET_DATA_API_KEY=...
BIRDEYE_API_KEY=...
AI_API_KEY=...
# how often the loops run (seconds): the monitor checks profit targets, the bot looks for entries at twice that interval
SCANNER_INTERVAL_SECONDS=60
MONITOR_INTERVAL_SECONDS=30
```

Leave out anything you don't use (see `.env.example`). The Vercel variables that only the website needs (`NEXT_PUBLIC_*`, `APP_URL`,
`CRON_SECRET`, the Upstash ones) aren't needed here.

## Notes

- The worker loops don't take the scheduler's lock, which is why the scheduler must be paused while they run.
- It scans and trims old data on its own (the retention job runs from the scanner loop).
- If the machine restarts, Docker brings the worker back (`restart: unless-stopped`).
