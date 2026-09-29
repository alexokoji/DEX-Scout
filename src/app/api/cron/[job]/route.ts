import { timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { logEvent, safeMessage } from "@/lib/events";
import { runAnalysisCycle } from "@/services/analysis";
import { runBotCycle } from "@/services/bot";
import { withLease } from "@/services/lease";
import { pruneOldData } from "@/services/maintenance";
import { runPositionMonitorCycle } from "@/services/positionMonitor";
import { runScanCycle } from "@/services/scanner";
import { runSignalCycle } from "@/services/signals";

export const dynamic = "force-dynamic";
// Vercel Hobby hard-caps functions at 60s regardless of what's requested here (vercel.json also pins
// these routes to 60). Keep this truthful rather than aspirational — see the lease TTL below, which is
// sized off this number.
export const maxDuration = 60;

/**
 * Serverless replacement for the long-running workers (used on Vercel, see vercel.json / VERCEL.md).
 * Vercel Cron calls these with `Authorization: Bearer $CRON_SECRET`. Any scheduler can call them the same way.
 *   scan    = scanner + analysis + signals (+ hourly data retention)
 *   monitor = position monitor (profit targets, health, emergency handling)
 *   execute = bot cycle + live-trade reconciliation
 */
// Each analysed token costs at least two outbound HTTP calls in live mode, one of them a candle fetch
// that shares a single process-wide, ~27/min pace queue with this same job's own discovery step (see
// geckoFetch in dexscreener.ts — GeckoTerminal's free tier 429s a burst well before its per-minute cap).
// That queue, not raw wall-clock, is the binding constraint: 6 chains' worth of discovery calls plus N
// candle calls, measured at ~2.6s apart each including real fetch time, must fit inside Hobby's real 60s
// cap. That estimate turned out optimistic in production — a run analysing 6 tokens still took 58.6s
// total, because per-token on-chain checks against free public RPC endpoints (no SLA, occasionally
// slow) run alongside the gecko queue, not instead of it, and a chunk of CONCURRENCY tokens only
// finishes when its slowest member does. 8 buys back real margin; nothing is permanently skipped — see
// runAnalysisCycle's docstring. The self-hosted worker loop has no such ceiling and calls
// runAnalysisCycle() unbounded.
const SERVERLESS_ANALYSIS_BATCH = 8;

const JOBS: Record<string, () => Promise<unknown>> = {
  async scan() {
    const scan = await runScanCycle();
    const analysis = await runAnalysisCycle(SERVERLESS_ANALYSIS_BATCH);
    const signals = await runSignalCycle();
    const pruned = new Date().getUTCMinutes() === 0 ? await pruneOldData().catch(() => -1) : null;
    return { scan, analysis, signals, pruned };
  },
  monitor: runPositionMonitorCycle,
  execute: runBotCycle,
};

function authorised(req: Request): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret || secret.length < 16) return false; // fail closed: cron endpoints are disabled until a secret is set
  const got = Buffer.from(req.headers.get("authorization") ?? "");
  const want = Buffer.from(`Bearer ${secret}`);
  return got.length === want.length && timingSafeEqual(got, want);
}

export async function GET(req: Request, ctx: { params: Promise<{ job: string }> }) {
  if (!authorised(req)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { job } = await ctx.params;
  const fn = JOBS[job];
  if (!fn) return NextResponse.json({ error: "Unknown job" }, { status: 404 });
  const t0 = Date.now();
  try {
    // Below maxDuration on purpose: if the platform kills this invocation for running past the real
    // 60s ceiling, the lease's `finally` release never executes (the runtime is torn down first), so a
    // stale lease from a killed run must expire quickly on its own — not sit "held" for minutes, which
    // would otherwise make every subsequent tick report "another run is still in progress" for far
    // longer than a single missed cycle.
    const out = await withLease(`cron:${job}`, 55, fn);
    if (!out.ran) return NextResponse.json({ job, skipped: "another run is still in progress" });
    return NextResponse.json({ job, ms: Date.now() - t0, result: out.result });
  } catch (err) {
    const msg = safeMessage(err);
    await logEvent({ type: "WORKER_ERROR", source: `cron:${job}`, level: "ERROR", message: msg });
    return NextResponse.json({ job, error: msg }, { status: 500 });
  }
}
