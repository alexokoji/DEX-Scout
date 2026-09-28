import { protectedRoute, serialize } from "@/lib/api";
import { runAnalysisCycle } from "@/services/analysis";
import { runScanCycle } from "@/services/scanner";
import { runSignalCycle } from "@/services/signals";

/** Triggers one full scan, analyse, signal pass on demand (the workers normally do this on a timer). */
export const POST = protectedRoute(
  async () => {
    const scan = await runScanCycle();
    const analysis = await runAnalysisCycle();
    const signals = await runSignalCycle();
    return serialize({ scan, analysis, signals });
  },
  { limit: { max: 4, windowMs: 60_000, key: "scan" } },
);