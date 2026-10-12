/**
 * Frees space in the database by deleting data nothing needs any more (see RETENTION_DAYS in src/services/maintenance.ts).
 * Positions, trades that happened, settings, wallets and bot wallets are never touched.
 *
 *   npm run db:prune                  dry run: counts what would go, changes nothing
 *   npm run db:prune -- --apply       deletes it
 *
 * It runs against whatever MONGODB_URI is in the environment (.env).
 */
import dns from "node:dns";
import "dotenv/config";

const apply = process.argv.includes("--apply");

async function main() {
  const uri = process.env.MONGODB_URI ?? "";
  if (!uri) throw new Error("MONGODB_URI is not set");
  // an Atlas "mongodb+srv" address is looked up with DNS queries some home resolvers refuse: ask public resolvers (this script only)
  if (uri.startsWith("mongodb+srv://")) dns.setServers(["1.1.1.1", "8.8.8.8"]);
  const { getDb, closeDb } = await import("../src/lib/db");
  const { pruneReport } = await import("../src/services/maintenance");
  const size = async () => {
    const s = await (await getDb()).command({ dbStats: 1, scale: 1024 * 1024 });
    return `data ${s.dataSize.toFixed(0)} MB + indexes ${s.indexSize.toFixed(0)} MB (stored: ${s.storageSize.toFixed(0)} + ${s.indexSize.toFixed(0)} MB)`;
  };
  console.log(`[prune] mode: ${apply ? "APPLY (deleting)" : "dry run (changes nothing)"}`);
  console.log(`[prune] before: ${await size()}`);
  try {
    // no time limit here: the scheduled run is bounded, this one finishes the job
    const r = await pruneReport(new Date(), { apply, budgetMs: 30 * 60_000 });
    for (const [k, n] of Object.entries(r).sort((a, b) => b[1] - a[1])) console.log(`  ${apply ? "deleted" : "would delete"} ${String(n).padStart(8)}  ${k}`);
    console.log(`[prune] ${apply ? "deleted" : "would delete"} ${Object.values(r).reduce((s, n) => s + n, 0)} rows in total`);
    if (apply) console.log(`[prune] after: ${await size()}`);
    else console.log("[prune] run again with --apply to delete them");
  } finally {
    await closeDb();
  }
}

main().catch((e) => {
  console.error("[prune] failed:", e instanceof Error ? e.message : e);
  process.exitCode = 1;
});
