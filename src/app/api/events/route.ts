import { protectedRoute, serialize } from "@/lib/api";
import { db } from "@/lib/db";

/** System event log (transparency/debugging). Optional ?type= and ?level= filters. */
export const GET = protectedRoute(async ({ req, user }) => {
  const sp = new URL(req.url).searchParams;
  const level = sp.get("level");
  const rows = await db.systemEvent.findMany({
    where: { OR: [{ userId: user.id }, { userId: null }], ...(sp.get("type") ? { type: sp.get("type")! } : {}), ...(level ? { level: level as never } : {}) },
    orderBy: { ts: "desc" },
    take: Math.min(500, Number(sp.get("limit") ?? 100)),
  });
  return serialize(rows);
});