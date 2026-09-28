/**
 * Zero-setup local MongoDB for development, as a single-node replica set (via the `mongodb-memory-server`
 * package, which downloads and runs a real `mongod` binary — nothing is faked). A replica set — even a
 * single-node one — is required for the multi-document transactions `withUserLock` uses; a plain standalone
 * `mongod` cannot run them, which is why this isn't just "any" local Mongo.
 *
 * Not for production — point MONGODB_URI at a real replica set (e.g. MongoDB Atlas) there.
 *
 *   npm run db:start
 */
import { MongoMemoryReplSet } from "mongodb-memory-server";
import fs from "node:fs";
import path from "node:path";
import net from "node:net";

const PORT = Number(process.env.EMBEDDED_MONGO_PORT ?? 27117);
const DB_NAME = "dexscout";
const dir = path.resolve(process.cwd(), ".data", "mongo");

function portOpen(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const s = net.createConnection({ port, host: "127.0.0.1" });
    s.once("connect", () => (s.destroy(), resolve(true)));
    s.once("error", () => resolve(false));
  });
}

export async function startEmbeddedMongo() {
  if (await portOpen(PORT)) {
    console.log(`[db] MongoDB already listening on :${PORT}`);
    return null;
  }
  fs.mkdirSync(dir, { recursive: true });
  console.log("[db] starting local MongoDB replica set (first run downloads the mongod binary; can take a minute)…");
  const replSet = await MongoMemoryReplSet.create({
    replSet: { name: "rs0", count: 1, storageEngine: "wiredTiger", dbName: DB_NAME },
    instanceOpts: [{ port: PORT, dbPath: dir, storageEngine: "wiredTiger" }],
  });
  const uri = replSet.getUri(DB_NAME);
  console.log(`[db] MongoDB ready: ${uri}`);
  const stop = async () => {
    await replSet.stop().catch(() => {});
    process.exit(0);
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  return replSet;
}

if (process.argv[1] && /embedded-db\.ts$/.test(process.argv[1].replace(/\\/g, "/"))) {
  startEmbeddedMongo().then((rs) => {
    if (!rs) process.exit(0);
    console.log("[db] running — press Ctrl+C to stop");
  });
}
