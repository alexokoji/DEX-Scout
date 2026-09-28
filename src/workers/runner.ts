import "dotenv/config";
import { env } from "@/lib/env";
import { logEvent, safeMessage } from "@/lib/events";
import { runAnalysisCycle } from "@/services/analysis";
import { runBotCycle } from "@/services/bot";
import { runPositionMonitorCycle } from "@/services/positionMonitor";
import { pruneOldData } from "@/services/maintenance";
import { runScanCycle } from "@/services/scanner";
import { runSignalCycle } from "@/services/signals";
import { touchWorker, type WorkerName } from "@/services/workerState";

export interface WorkerDef {
  name: WorkerName;
  intervalMs: () => number;
  run: () => Promise<unknown>;
}

/**
 * Worker definitions. Each worker is independent: it can run in its own process (`npm run worker:scanner`),
 * all together (`npm run workers`), or be replaced by a queue consumer (BullMQ/SQS) that calls the same `run`.
 */
let scanCount = 0;
async function scanAndMaintain() {
  const r = await runScanCycle();
  if (++scanCount % 120 === 1) await pruneOldData().catch(() => {}); // roughly hourly at the default interval
  return r;
}

export const WORKER_DEFS: Record<string, WorkerDef> = {
  scanner: { name: "scanner-worker", intervalMs: () => env().SCANNER_INTERVAL_SECONDS * 1000, run: scanAndMaintain },
  analysis: { name: "analysis-worker", intervalMs: () => env().SCANNER_INTERVAL_SECONDS * 1500, run: runAnalysisCycle },
  signal: { name: "signal-worker", intervalMs: () => env().SCANNER_INTERVAL_SECONDS * 1500, run: runSignalCycle },
  monitor: { name: "position-monitor-worker", intervalMs: () => env().MONITOR_INTERVAL_SECONDS * 1000, run: runPositionMonitorCycle },
  executor: { name: "trade-executor-worker", intervalMs: () => env().MONITOR_INTERVAL_SECONDS * 2000, run: runBotCycle },
};

/** Serial loop with no overlap: the next tick is scheduled only after the previous run finished. */
export function startLoop(def: WorkerDef): () => void {
  let stopped = false;
  let timer: NodeJS.Timeout | undefined;
  const tick = async () => {
    if (stopped) return;
    const t0 = Date.now();
    try {
      await def.run();
    } catch (err) {
      const msg = safeMessage(err);
      console.error(`[${def.name}] cycle failed: ${msg}`);
      await touchWorker(def.name, msg).catch(() => {});
      await logEvent({ type: "WORKER_ERROR", source: def.name, level: "ERROR", message: msg });
    }
    if (!stopped) timer = setTimeout(tick, Math.max(1000, def.intervalMs() - (Date.now() - t0)));
  };
  void tick();
  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
  };
}

/** One full pass through the pipeline, used to warm the database at startup. */
export async function bootstrapPipeline() {
  await runScanCycle();
  await runAnalysisCycle();
  await runSignalCycle();
}
