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
// Each analysed token needs one candle fetch through geckoFetch's single, serialized, ~27/min pace
// queue (dexscreener.ts) -- and that queue only services ~1 call every ~2.2-2.7s NO MATTER how many
// tokens are dispatched "concurrently". With CONCURRENCY=8 tokens competing for that one queue, a token
// near the back can exceed a 20s per-token deadline purely from queue wait, with no error of its own --
// and one slow/retried call ahead of it pushes every token behind it further out. Reproduced in
// production: 6 of 8 analysed tokens timed out in one run, all at exactly 20000ms.
// A hard platform timeout (a killed function, no lease released) is a categorically worse outcome than
// a token failing this tick and retrying next -- see runAnalysisCycle's docstring, and PER_TOKEN_DEADLINE_MS
// there. So this stays conservative: 5 keeps queue depth shallow enough that most tokens clear well
// inside their deadline even with one slow call ahead of them, at the cost of processing fewer per tick.
// The self-hosted worker loop has no such ceiling and calls runAnalysisCycle() unbounded.
const SERVERLESS_ANALYSIS_BATCH = 5;

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
