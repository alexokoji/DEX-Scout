/**
 * Worker entry point.
 *   tsx src/workers/main.ts                → all workers
 *   tsx src/workers/main.ts scanner        → only the scanner worker
 *   tsx src/workers/main.ts monitor signal → several
 * Workers never depend on a browser being open.
 */
import { bootstrapPipeline, startLoop, WORKER_DEFS } from "./runner";
import { logEvent } from "@/lib/events";

async function main() {
  const wanted = process.argv.slice(2);
  const names = wanted.length ? wanted : Object.keys(WORKER_DEFS);
  for (const n of names) if (!WORKER_DEFS[n]) throw new Error(`Unknown worker "${n}". Available: ${Object.keys(WORKER_DEFS).join(", ")}`);

  if (names.includes("scanner") && !process.env.SKIP_BOOTSTRAP) {
    console.log("[workers] warming pipeline (scan → analyse → signal)…");
    try {
      await bootstrapPipeline();
    } catch (e) {
      console.error("[workers] bootstrap failed:", e instanceof Error ? e.message : e);
    }
  }

  const stops = names.map((n) => {
    console.log(`[workers] starting ${WORKER_DEFS[n].name}`);
    return startLoop(WORKER_DEFS[n]);
  });
  await logEvent({ type: "SCANNER_STARTED", source: "workers", message: `Workers started: ${names.join(", ")}` });

  const shutdown = () => {
    stops.forEach((s) => s());
    setTimeout(() => process.exit(0), 300);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
