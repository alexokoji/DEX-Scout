/**
 * `npm run dev` — one command for local development:
 *   1. starts an embedded PostgreSQL if nothing is listening on the configured port (skipped for external DBs)
 *   2. applies migrations
 *   3. starts background workers + the Next.js dev server
 */
import "dotenv/config";
import { spawn, spawnSync } from "node:child_process";
import { startEmbeddedPostgres } from "./embedded-db";

process.env.DIRECT_URL ||= process.env.DATABASE_URL; // migrate uses DIRECT_URL; locally it is the same database
const isWin = process.platform === "win32";
const npx = isWin ? "npx.cmd" : "npx";
const env = { ...process.env, PRISMA_ENGINES_MIRROR: process.env.PRISMA_ENGINES_MIRROR };

async function main() {
  const dbUrl = process.env.DATABASE_URL ?? "";
  if (/localhost:5433|127\.0\.0\.1:5433/.test(dbUrl) || !dbUrl) {
    await startEmbeddedPostgres();
  }

  console.log("[dev] applying database migrations…");
  const mig = spawnSync(npx, ["prisma", "migrate", "deploy"], { stdio: "inherit", env, shell: isWin });
  if (mig.status !== 0) {
    console.error("[dev] migrations failed — check DATABASE_URL and that PostgreSQL is reachable");
    process.exit(1);
  }
  spawnSync(npx, ["tsx", "prisma/seed.ts"], { stdio: "inherit", env, shell: isWin });

  const children = [
    spawn(npx, ["tsx", "src/workers/main.ts"], { stdio: "inherit", env, shell: isWin }),
    spawn(npx, ["next", "dev"], { stdio: "inherit", env, shell: isWin }),
  ];
  const stop = () => children.forEach((c) => c.kill());
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  children.forEach((c) => c.on("exit", (code) => code && process.exit(code)));
}

main();
