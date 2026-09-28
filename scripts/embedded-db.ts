/**
 * Zero-setup local PostgreSQL for development (real Postgres binaries via the `embedded-postgres` package).
 * Not for production — point DATABASE_URL at a managed/self-hosted Postgres there.
 *
 *   npm run db:start
 */
import EmbeddedPostgres from "embedded-postgres";
import fs from "node:fs";
import path from "node:path";
import net from "node:net";

const PORT = Number(process.env.EMBEDDED_PG_PORT ?? 5433);
const DB_NAME = "dexscout";
const dir = path.resolve(process.cwd(), ".data", "pg");

function portOpen(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const s = net.createConnection({ port, host: "127.0.0.1" });
    s.once("connect", () => (s.destroy(), resolve(true)));
    s.once("error", () => resolve(false));
  });
}

export async function startEmbeddedPostgres() {
  if (await portOpen(PORT)) {
    console.log(`[db] PostgreSQL already listening on :${PORT}`);
    return null;
  }
  const pg = new EmbeddedPostgres({
    databaseDir: dir,
    user: "postgres",
    password: "postgres",
    port: PORT,
    persistent: true,
    // Windows would otherwise create a WIN1252 cluster that rejects characters such as arrows in event messages
    initdbFlags: ["--encoding=UTF8", "--locale=C"],
    onLog: () => {},
    onError: (e) => console.error("[db]", e),
  });
  if (!fs.existsSync(path.join(dir, "PG_VERSION"))) {
    console.log("[db] initialising local database cluster…");
    await pg.initialise();
  }
  await pg.start();
  try {
    await pg.createDatabase(DB_NAME);
  } catch {
    /* already exists */
  }
  try {
    const client = pg.getPgClient();
    await client.connect();
    const enc = (await client.query("SHOW server_encoding")).rows[0]?.server_encoding;
    await client.end();
    if (enc && enc !== "UTF8") console.warn(`[db] WARNING: cluster encoding is ${enc}, expected UTF8. Delete the .data/pg folder and restart to recreate it.`);
  } catch {
    /* best effort */
  }
  console.log(`[db] PostgreSQL ready: postgresql://postgres:postgres@localhost:${PORT}/${DB_NAME}`);
  const stop = async () => {
    await pg.stop().catch(() => {});
    process.exit(0);
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  return pg;
}

if (process.argv[1] && /embedded-db\.ts$/.test(process.argv[1].replace(/\\/g, "/"))) {
  startEmbeddedPostgres().then((pg) => {
    if (!pg) process.exit(0);
    console.log("[db] running — press Ctrl+C to stop");
  });
}
