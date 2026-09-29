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
// Each analysed token costs at least two outbound HTTP calls in live mode. Left unbounded, a scan with
// hundreds of qualifying tokens can outrun Hobby's 60s function cap and the platform kills the whole
// request before anything is saved. Bounding it here just paces the work across cron ticks (every ~2min);
// nothing is permanently skipped — see runAnalysisCycle's docstring. The self-hosted worker loop has no
// such ceiling and calls runAnalysisCycle() unbounded.
const SERVERLESS_ANALYSIS_BATCH = 40;

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
