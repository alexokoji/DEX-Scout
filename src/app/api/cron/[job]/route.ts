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
// Candles used to be a hard requirement and gated entirely on geckoFetch's shared, serialized, ~27/min
// pace queue -- with enough tokens in a batch, a token near the back of that queue could exceed its
// per-token deadline purely from queue wait, no error of its own required (reproduced in production: 6 of
// 8 analysed tokens timed out in one run, all at exactly the old 20000ms deadline). Candles are now
// optional, capped at a fixed 6s regardless of queue depth (CANDLE_FETCH_DEADLINE_MS), and the on-chain
// RPC calls are capped at 6s each too -- so one token's worst case is now a bounded sum (~20s) rather
// than an unbounded queue wait, and 10 keeps total analysis-phase wall-clock comfortably inside the
// scan job's share of Hobby's 60s cap even if several tokens hit their worst case at once. Nothing is
// permanently skipped -- see runAnalysisCycle's docstring. The self-hosted worker loop has no such
// ceiling and calls runAnalysisCycle() unbounded.
const SERVERLESS_ANALYSIS_BATCH = 10;

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
