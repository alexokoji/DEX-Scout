/**
 * `npm run dev` — one command for local development:
 *   1. starts an embedded local MongoDB replica set if nothing is listening on the configured port
 *   2. ensures indexes (Mongo has no migration engine)
 *   3. seeds the demo user (mock mode only)
 *   4. starts background workers + the Next.js dev server
 */
import "dotenv/config";
import { spawn, spawnSync } from "node:child_process";
import { startEmbeddedMongo } from "./embedded-db";

const isWin = process.platform === "win32";
const npx = isWin ? "npx.cmd" : "npx";
const env = { ...process.env };

async function main() {
  const uri = process.env.MONGODB_URI ?? "";
  if (/127\.0\.0\.1:27117|localhost:27117/.test(uri) || !uri) {
    await startEmbeddedMongo();
  }

  console.log("[dev] ensuring indexes…");
  const idx = spawnSync(npx, ["tsx", "scripts/ensure-indexes.ts"], { stdio: "inherit", env, shell: isWin });
  if (idx.status !== 0) {
    console.error("[dev] index setup failed — check MONGODB_URI and that MongoDB is reachable");
    process.exit(1);
  }
  spawnSync(npx, ["tsx", "scripts/seed.ts"], { stdio: "inherit", env, shell: isWin });

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
