import { protectedRoute, serialize } from "@/lib/api";
import { collections, withIds } from "@/lib/db";

/** System event log (transparency/debugging). Optional ?type= and ?level= filters. */
export const GET = protectedRoute(async ({ req, user }) => {
  const sp = new URL(req.url).searchParams;
  const level = sp.get("level");
  const events = await collections.systemEvents();
  const rows = await events
    .find({ $or: [{ userId: user.id }, { userId: null }], ...(sp.get("type") ? { type: sp.get("type")! } : {}), ...(level ? { level: level as never } : {}) })
    .sort({ ts: -1 })
    .limit(Math.min(500, Number(sp.get("limit") ?? 100)))
    .toArray();
  return serialize(withIds(rows));
});
