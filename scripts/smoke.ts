/** Runs the full pipeline once against the configured database/providers and prints a summary. */
import "dotenv/config";
import { closeDb, collections } from "../src/lib/db";
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

  const signals = await collections.signals();
  const tokens = await collections.tokens();
  const sigs = await signals.find({ status: "ACTIVE" }).sort({ score: -1 }).limit(8).toArray();
  const tokenById = new Map((await tokens.find({ _id: { $in: sigs.map((s) => s.tokenId) } }).toArray()).map((t) => [t._id, t]));
  for (const s of sigs) {
    const t = tokenById.get(s.tokenId);
    if (!t) continue;
    console.log(s.type, t.symbol.padEnd(7), "score", s.score.toFixed(0), s.riskLevel, "mcap", (t.marketCapUsd / 1e6).toFixed(2) + "M", "liq", Math.round(t.liquidityUsd / 1000) + "K");
  }
  const byStage = await tokens.aggregate([{ $group: { _id: "$stage", count: { $sum: 1 } } }]).toArray();
  console.log(byStage);
  await closeDb();
}
main();
