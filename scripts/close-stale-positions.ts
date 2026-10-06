/**
 * Close open positions that are really over (sold, or the tokens are gone from the wallet).
 *
 *   npm run positions:close-stale                 report only: changes nothing
 *   npm run positions:close-stale -- --apply      close them
 *
 * It runs against whatever MONGODB_URI is in the environment (the local .env points at the local development database). For
 * production, give it the production URI for this one command and nothing else:
 *   PowerShell:  $env:MONGODB_URI = "<atlas uri>"; npm run positions:close-stale
 *   bash:        MONGODB_URI="<atlas uri>" npm run positions:close-stale
 * It always reads the real chains (never the mock market), because "the wallet holds none" has to be checked for real.
 * See src/services/positionCleanup.ts for exactly what it will and will not close.
 */
import "dotenv/config";

const apply = process.argv.includes("--apply");

// This must reach the chain: a position is only closed on the chain's word. Set before anything reads the environment.
process.env.MOCK_PROVIDER = "false";

const maskedTarget = (uri: string) => {
  try {
    const u = new URL(uri.replace(/^mongodb(\+srv)?:\/\//, "http://"));
    return `${u.hostname}${u.port ? `:${u.port}` : ""}${u.pathname}`;
  } catch {
    return "(unreadable URI)";
  }
};

async function main() {
  const uri = process.env.MONGODB_URI ?? "";
  if (!uri) throw new Error("MONGODB_URI is not set");
  const { closeDb } = await import("../src/lib/db");
  const { cleanUpPositions } = await import("../src/services/positionCleanup");
  console.log(`[cleanup] database: ${maskedTarget(uri)}`);
  console.log(`[cleanup] mode: ${apply ? "APPLY (will close positions)" : "dry run (changes nothing)"}`);
  try {
    const r = await cleanUpPositions({ apply });
    console.log(`[cleanup] checked ${r.checked} open position(s)`);
    if (r.pendingConfirmable) console.log(`[cleanup] ${r.pendingConfirmable} sent trade(s) have confirmed on-chain${apply ? `; ${r.settledTrades} booked` : " and would be booked"}`);
    for (const f of r.stale) console.log(`  ${apply ? "closed " : "would close"}  ${f.symbol.padEnd(12)} ${f.chain.padEnd(10)} ${f.reason.padEnd(17)} ${f.detail}`);
    for (const k of r.kept.filter((k) => !/still waiting|opened a moment ago/.test(k.why))) console.log(`  left alone   ${k.symbol.padEnd(12)} ${k.why}`);
    console.log(apply ? `[cleanup] closed ${r.closed} position(s)` : `[cleanup] ${r.stale.length} position(s) would be closed. Run again with --apply to close them.`);
  } finally {
    await closeDb();
  }
}

main().catch((e) => {
  console.error("[cleanup] failed:", e instanceof Error ? e.message : e);
  process.exitCode = 1;
});
