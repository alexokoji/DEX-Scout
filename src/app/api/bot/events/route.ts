import { protectedRoute, serialize } from "@/lib/api";
import { collections, withIds } from "@/lib/db";

export const GET = protectedRoute(async ({ req, user }) => {
  const limit = Math.min(200, Number(new URL(req.url).searchParams.get("limit") ?? 50));
  const events = await collections.systemEvents();
  const rows = await events.find({ $or: [{ userId: user.id }, { source: "bot" }] }).sort({ ts: -1 }).limit(limit).toArray();
  return serialize(withIds(rows));
});
