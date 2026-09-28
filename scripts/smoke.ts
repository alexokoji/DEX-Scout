/** Runs the full pipeline once against the configured database/providers and prints a summary. */
import "dotenv/config";
import { db } from "../src/lib/db";
import { runAnalysisCycle } from "../src/services/analysis";
import { runScanCycle } from "../src/services/scanner";
import { runSignalCycle } from "../src/services/signals";

async function main() {
  console.time("scan");
  console.log(await runScanCycle());
  console.timeEnd("scan");
  console.time("analysis");
  console.log(await runAnalysisCycle());
  console.timeEnd("analysis");
  console.time("signals");
  console.log(await runSignalCycle());
  console.timeEnd("signals");
  const sigs = await db.signal.findMany({ where: { status: "ACTIVE" }, include: { token: true }, orderBy: { score: "desc" }, take: 8 });
  for (const s of sigs) {
    console.log(s.type, s.token.symbol.padEnd(7), "score", s.score.toFixed(0), s.riskLevel, "mcap", (s.token.marketCapUsd / 1e6).toFixed(2) + "M", "liq", Math.round(s.token.liquidityUsd / 1000) + "K");
  }
  const byStage = await db.token.groupBy({ by: ["stage"], _count: true });
  console.log(byStage);
  await db.$disconnect();
}
main();
