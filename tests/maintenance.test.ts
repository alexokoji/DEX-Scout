import { describe, expect, it } from "vitest";
import { collections, newId } from "@/lib/db";

let up = false;
try {
  const events = await collections.systemEvents();
  await events.findOne({});
  up = true;
} catch {
  up = false;
}

(up ? describe : describe.skip)("retention", () => {
  it("prunes old debug events but keeps recent ones", async () => {
    const { pruneOldData } = await import("@/services/maintenance");
    const events = await collections.systemEvents();
    const oldId = newId();
    const freshId = newId();
    await events.insertOne({ _id: oldId, ts: new Date(Date.now() - 5 * 86_400_000), type: "SCANNER_COMPLETED", level: "DEBUG", source: "test-retention", message: "old", userId: null, data: null });
    await events.insertOne({ _id: freshId, ts: new Date(), type: "SCANNER_COMPLETED", level: "DEBUG", source: "test-retention", message: "fresh", userId: null, data: null });
    await pruneOldData();
    expect(await events.findOne({ _id: oldId })).toBeNull();
    expect(await events.findOne({ _id: freshId })).not.toBeNull();
    await events.deleteOne({ _id: freshId });
  });
});
