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
export const maxDuration = 300;

/**
 * Serverless replacement for the long-running workers (used on Vercel, see vercel.json / VERCEL.md).
 * Vercel Cron calls these with `Authorization: Bearer $CRON_SECRET`. Any scheduler can call them the same way.
 *   scan    = scanner + analysis + signals (+ hourly data retention)
 *   monitor = position monitor (profit targets, health, emergency handling)
 *   execute = bot cycle + live-trade reconciliation
 */
const JOBS: Record<string, () => Promise<unknown>> = {
  async scan() {
    const scan = await runScanCycle();
    const analysis = await runAnalysisCycle();
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
    const out = await withLease(`cron:${job}`, 280, fn);
    if (!out.ran) return NextResponse.json({ job, skipped: "another run is still in progress" });
    return NextResponse.json({ job, ms: Date.now() - t0, result: out.result });
  } catch (err) {
    const msg = safeMessage(err);
    await logEvent({ type: "WORKER_ERROR", source: `cron:${job}`, level: "ERROR", message: msg });
    return NextResponse.json({ job, error: msg }, { status: 500 });
  }
}
