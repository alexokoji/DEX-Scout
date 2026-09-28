import { protectedRoute, serialize } from "@/lib/api";
import { db } from "@/lib/db";

export const GET = protectedRoute(async ({ req, user }) => {
  const limit = Math.min(200, Number(new URL(req.url).searchParams.get("limit") ?? 50));
  return serialize(await db.systemEvent.findMany({ where: { OR: [{ userId: user.id }, { source: "bot" }] }, orderBy: { ts: "desc" }, take: limit }));
});