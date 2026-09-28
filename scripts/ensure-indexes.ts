/** Creates every index the app relies on. Mongo has no migration engine, so this replaces `prisma migrate`. */
import "dotenv/config";
import { closeDb, ensureIndexes } from "../src/lib/db";

ensureIndexes()
  .then(() => {
    console.log("[db] indexes ensured");
  })
  .catch((e) => {
    console.error("[db] failed to ensure indexes:", e instanceof Error ? e.message : e);
    process.exitCode = 1;
  })
  .finally(() => closeDb());
