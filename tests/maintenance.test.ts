import { describe, expect, it } from "vitest";
import { db } from "@/lib/db";

let up = false;
try { await db.$queryRaw`SELECT 1`; up = true; } catch { up = false; }

(up ? describe : describe.skip)("retention", () => {
  it("prunes old debug events but keeps recent ones", async () => {
    const { pruneOldData } = await import("@/services/maintenance");
    const old = await db.systemEvent.create({ data: { type: "SCANNER_COMPLETED", source: "test-retention", level: "DEBUG", message: "old", ts: new Date(Date.now() - 5 * 86_400_000) } });
    const fresh = await db.systemEvent.create({ data: { type: "SCANNER_COMPLETED", source: "test-retention", level: "DEBUG", message: "fresh" } });
    await pruneOldData();
    expect(await db.systemEvent.findUnique({ where: { id: old.id } })).toBeNull();
    expect(await db.systemEvent.findUnique({ where: { id: fresh.id } })).not.toBeNull();
    await db.systemEvent.delete({ where: { id: fresh.id } });
  });
});