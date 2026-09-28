import { protectedRoute, serialize } from "@/lib/api";
import { db } from "@/lib/db";

export const GET = protectedRoute(async ({ req, user }) => {
  const sp = new URL(req.url).searchParams;
  const status = sp.get("status");
  const trades = await db.trade.findMany({
    where: { userId: user.id, ...(status ? { status: status as never } : {}) },
    include: { token: { select: { symbol: true, address: true } }, transaction: { select: { signature: true, status: true } } },
    orderBy: { createdAt: "desc" },
    take: Math.min(500, Number(sp.get("limit") ?? 100)),
  });
  // unsigned payloads and provider quote internals are not needed by list consumers
  return serialize(trades.map(({ quote, ...t }) => ({ ...t, quote: undefined, reason: (quote as { reason?: string } | null)?.reason ?? null })));
});
