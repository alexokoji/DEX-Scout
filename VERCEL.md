# Deploying on Vercel (Hobby plan)

The Next.js app (pages + API routes) runs entirely on Vercel. The background jobs that used to be `npm run workers`
are now three plain API routes, `/api/cron/scan`, `/api/cron/monitor`, `/api/cron/execute` — but **Vercel Hobby's
built-in Cron only fires once a day**, far too slow for a live scanner/trading bot. So on Hobby, something *outside*
Vercel has to call those three URLs on a schedule instead. This file sets that up with free external services.

```
cron-job.org (free, ~1/min)  -\
GitHub Actions (free, ~5/min) -+-> GET /api/cron/scan | /monitor | /execute -> same service layer as the local workers
                               /       (Authorization: Bearer CRON_SECRET)
Browser -> Next.js pages / API routes -> MongoDB (Atlas, via Vercel Marketplace)
```

Nothing in the app code cares who calls these routes — only that the caller sends the right bearer token. Each job
also takes a short database lease, so if two schedulers (or two overlapping runs) call the same job at once, the
second one just reports `"skipped: another run is still in progress"` instead of running twice.

`vercel.json` in this repo deliberately has **no `crons` entry** — a Hobby project errors on deploy if
`vercel.json` asks for more than daily crons, so cron scheduling here is 100% external.

## 1. Database
1. Vercel dashboard → **Storage → Create → MongoDB Atlas** → connect it to the project. This injects a connection string as a project env var automatically (or create a free Atlas cluster yourself at mongodb.com/atlas and copy its connection string — either way it must be a real replica set, which every Atlas tier is).
2. Set/confirm `MONGODB_URI` to that connection string (it already includes the database name and `retryWrites=true`, which Atlas needs).
3. Indexes are created automatically during the build: `npm run vercel-build` = `tsx scripts/ensure-indexes.ts && next build`. Mongo has no migration engine, so there's nothing else to run.

## 2. Environment variables (Production + Preview)
| Variable | Value |
|---|---|
| `AUTH_SECRET` | `openssl rand -base64 32` — required; the app refuses to boot in production without a real one |
| `CRON_SECRET` | `openssl rand -hex 24` — the bearer token the external scheduler sends. **The `/api/cron/*` routes return 401 for everyone until this is set** |
| `MOCK_PROVIDER` | `true` to run on simulated token/market data (there is no demo account or paper trading — scanning/analysis/signals are simulated, but trading is always LIVE and still requires `LIVE_TRADING_ENABLED` + real providers). `false` for real data |
| `NEXT_PUBLIC_APP_URL` | your production URL, e.g. `https://dex-scout.vercel.app` |
| `UPSTASH_REDIS_REST_URL` / `_TOKEN` | strongly recommended — serverless instances don't share memory, so the in-memory rate limiter doesn't actually limit anything across them (Vercel Marketplace has Upstash's free tier) |
| `MONGODB_DB` | only needed if you want to override the database name baked into `MONGODB_URI` |
| Real-data mode | `SOLANA_RPC_URL`, `NEXT_PUBLIC_SOLANA_RPC_URL`, EVM `*_RPC_URL`s, `DEX_PROVIDER_API_KEY`, `ZEROX_API_KEY`, `BIRDEYE_API_KEY`, `AI_API_KEY` (see `.env.example`) |
| Live trading | `LIVE_TRADING_ENABLED=true` (only with `MOCK_PROVIDER=false`; read SECURITY.md first) |

`NEXT_PUBLIC_*` values are exposed to the browser — never put secrets in them.

## 3. Deploy
```bash
npm i -g vercel
vercel link
vercel env add AUTH_SECRET production      # repeat for every variable above
vercel --prod
```
or just import the Git repository in the Vercel dashboard. Once it's live, note the URL — you'll need it for step 4.

## 4. Set up the external scheduler (pick one; cron-job.org is the simpler option)

### Option A — cron-job.org (recommended: free, ~1 minute granularity)
Account creation and login aren't things any automated tool should do on your behalf, so do the account part
yourself; wiring up the three jobs afterwards can be scripted.

1. Create a free account at [cron-job.org](https://cron-job.org) and verify your email.
2. Console → **Settings → API key** → generate one and copy it (treat it like a password — it grants full control of your cron-job.org account).
3. Run the setup script from this repo with that key:
   ```bash
   CRONJOB_ORG_API_KEY=<your key> APP_URL=https://<your-app>.vercel.app CRON_SECRET=<your CRON_SECRET> npm run cron:setup
   ```
   This creates (or updates, if run again) three jobs — `dexscout-scan` (every 2 min), `dexscout-monitor` and `dexscout-execute` (every 1 min) — each hitting the matching `/api/cron/*` URL with the `Authorization: Bearer <CRON_SECRET>` header already attached, with failure/success/disable email notifications turned on. The key only ever goes from your shell to cron-job.org's API — it isn't logged or sent anywhere else.
4. In the cron-job.org console, open each job and click "Run now" once to confirm you get a `200`, not a `401` (a `401` usually means `CRON_SECRET` doesn't match what's set on Vercel).

Prefer doing it by hand instead? Console → **Create cronjob** → paste in the URL, set the schedule, then under **Advanced → Headers** add `Authorization: Bearer <your CRON_SECRET>`, method `GET`, and save — same three URLs/schedules as above.

### Option B — GitHub Actions (free, code-based, ~5 minute granularity)
This repo already includes `.github/workflows/cron.yml`, which calls all three routes every 5 minutes. To enable it:
1. Push this repository to GitHub (`git init && git remote add origin ... && git push`, if you haven't already).
2. In the GitHub repo → **Settings → Secrets and variables → Actions → New repository secret**, add:
   - `APP_URL` = `https://<your-app>.vercel.app` (no trailing slash)
   - `CRON_SECRET` = the same value as the Vercel env var
3. Go to the **Actions** tab → "DEX Scout background jobs" → **Run workflow** to trigger it manually and confirm all three steps succeed.

GitHub's scheduler doesn't reliably run more often than every 5 minutes regardless of what the cron expression says,
so option A is more responsive for position monitoring and trade execution. You can also run both at once — the
lease means it's harmless if they occasionally overlap.

### Why not Vercel Cron itself?
Hobby allows Vercel Cron, but only **once per day**, which is far too infrequent for continuous scanning and
position monitoring. If you later upgrade to **Pro**, Vercel Cron supports per-minute schedules and you can drop the
external scheduler entirely — add back a `crons` array to `vercel.json` pointing at the same three URLs and delete
the cron-job.org jobs / GitHub Actions workflow.

## 5. Verify it's working
- Check the **Dashboard** page in the app — the "Background workers" card reads heartbeats from the database, so it
  shows the cron jobs as alive/stale exactly like it did with the local workers.
- Or call a job by hand: `curl -H "Authorization: Bearer $CRON_SECRET" https://<your-app>.vercel.app/api/cron/scan`
- Register an account on the login page once tokens have been scanned — there is no demo login.

## 6. What is different from local dev
- No `npm run workers` process: the same `scan` / `monitor` / `execute` cycles run as one-shot API calls instead of a loop.
- `scan` also runs data retention roughly once an hour (keyed off the minute of the call, so it self-paces regardless of how often the scheduler fires).
- Functions are capped at `maxDuration: 60` (Hobby's ceiling) in `vercel.json` — comfortably enough for the mock provider; if you switch to real providers and a very large token universe pushes a run past 60s, either narrow the scanner filters or upgrade to Pro (`maxDuration` up to 300s).
- The embedded dev MongoDB from `npm run dev` is not used in production; `MONGODB_URI` must point at Atlas (or any real MongoDB replica set).

## 7. Checklist before pointing real users at it
- [ ] Strong `AUTH_SECRET` and `CRON_SECRET` set
- [ ] External scheduler (cron-job.org and/or GitHub Actions) set up and confirmed returning `200`, not `401`
- [ ] Upstash Redis configured for rate limiting
- [ ] Atlas backups enabled
- [ ] Vercel deployment protection / custom domain configured
- [ ] Reviewed SECURITY.md and the capital limits in Settings -> Trading before enabling `LIVE_TRADING_ENABLED` — there is no paper/simulated mode to rehearse in first; the first trade is real
