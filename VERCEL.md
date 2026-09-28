# Deploying on Vercel (Hobby plan)

The Next.js app (pages + API routes) runs entirely on Vercel. The background jobs that used to be `npm run workers`
are now three plain API routes, `/api/cron/scan`, `/api/cron/monitor`, `/api/cron/execute` — but **Vercel Hobby's
built-in Cron only fires once a day**, far too slow for a live scanner/trading bot. So on Hobby, something *outside*
Vercel has to call those three URLs on a schedule instead. This file sets that up with free external services.

```
cron-job.org (free, ~1/min)  -\
GitHub Actions (free, ~5/min) -+-> GET /api/cron/scan | /monitor | /execute -> same service layer as the local workers
                               /       (Authorization: Bearer CRON_SECRET)
Browser -> Next.js pages / API routes -> PostgreSQL (Neon, via Vercel Marketplace)
```

Nothing in the app code cares who calls these routes — only that the caller sends the right bearer token. Each job
also takes a short database lease, so if two schedulers (or two overlapping runs) call the same job at once, the
second one just reports `"skipped: another run is still in progress"` instead of running twice.

`vercel.json` in this repo deliberately has **no `crons` entry** — a Hobby project errors on deploy if
`vercel.json` asks for more than daily crons, so cron scheduling here is 100% external.

## 1. Database
1. Vercel dashboard → **Storage → Create → Neon (Postgres)** → connect it to the project. This injects connection strings as project env vars automatically.
2. Set/confirm:
   - `DATABASE_URL` = the **pooled** connection string (host contains `-pooler`), with `?sslmode=require&pgbouncer=true&connect_timeout=15`
   - `DIRECT_URL` = the **un-pooled** connection string (used only by `prisma migrate`)
3. Migrations run automatically during the build: `npm run vercel-build` = `prisma generate && prisma migrate deploy && next build`.

## 2. Environment variables (Production + Preview)
| Variable | Value |
|---|---|
| `AUTH_SECRET` | `openssl rand -base64 32` — required; the app refuses to boot in production without a real one |
| `CRON_SECRET` | `openssl rand -hex 24` — the bearer token the external scheduler sends. **The `/api/cron/*` routes return 401 for everyone until this is set** |
| `MOCK_PROVIDER` | `true` for a demo deployment (simulated data, demo login). `false` for real data |
| `NEXT_PUBLIC_APP_URL` | your production URL, e.g. `https://dex-scout.vercel.app` |
| `UPSTASH_REDIS_REST_URL` / `_TOKEN` | strongly recommended — serverless instances don't share memory, so the in-memory rate limiter doesn't actually limit anything across them (Vercel Marketplace has Upstash's free tier) |
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

### Option A — cron-job.org (recommended: free, no code, ~1 minute granularity)
1. Create a free account at [cron-job.org](https://cron-job.org).
2. Create three cron jobs, one per URL:

   | Title | URL | Schedule |
   |---|---|---|
   | dexscout-scan | `https://<your-app>.vercel.app/api/cron/scan` | every 2 minutes |
   | dexscout-monitor | `https://<your-app>.vercel.app/api/cron/monitor` | every 1 minute |
   | dexscout-execute | `https://<your-app>.vercel.app/api/cron/execute` | every 1 minute |

3. For each job, under **Advanced → Headers**, add: `Authorization: Bearer <your CRON_SECRET>` (exact value you set in step 2 above).
4. Method: `GET`. Save, then click "Run now" on each to confirm you get a `200` with a JSON body (not a `401`).
5. Turn on email notifications for failures under each job's settings so you notice if the app goes down.

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
- In mock mode, press **Continue with demo account** on the login page once tokens have been scanned.

## 6. What is different from local dev
- No `npm run workers` process: the same `scan` / `monitor` / `execute` cycles run as one-shot API calls instead of a loop.
- `scan` also runs data retention roughly once an hour (keyed off the minute of the call, so it self-paces regardless of how often the scheduler fires).
- Functions are capped at `maxDuration: 60` (Hobby's ceiling) in `vercel.json` — comfortably enough for the mock provider; if you switch to real providers and a very large token universe pushes a run past 60s, either narrow the scanner filters or upgrade to Pro (`maxDuration` up to 300s).
- The embedded dev Postgres from `npm run dev` is not used in production; `DATABASE_URL` must point at Neon (or any real Postgres).

## 7. Checklist before pointing real users at it
- [ ] Strong `AUTH_SECRET` and `CRON_SECRET` set; demo login only if `MOCK_PROVIDER=true` is intended
- [ ] External scheduler (cron-job.org and/or GitHub Actions) set up and confirmed returning `200`, not `401`
- [ ] Upstash Redis configured for rate limiting
- [ ] Neon database backups enabled
- [ ] Vercel deployment protection / custom domain configured
- [ ] Paper-traded for a while before enabling `LIVE_TRADING_ENABLED`
