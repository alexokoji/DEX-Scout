import { protectedRoute, serialize } from "@/lib/api";
import { db } from "@/lib/db";

/** LIVE trades (manual or bot-created) waiting for the user's wallet signature, with their unsigned transactions. */
export const GET = protectedRoute(async ({ user }) => {
  const rows = await db.trade.findMany({
    where: { userId: user.id, environment: "LIVE", status: "PREPARED", expiresAt: { gt: new Date() } },
    include: { token: { select: { symbol: true, address: true, chain: true } }, transaction: { select: { unsignedTx: true } } },
    orderBy: { createdAt: "desc" },
  });
  return serialize(rows.map(({ quote, transaction, ...t }) => ({ ...t, unsignedTxBase64: transaction?.unsignedTx ?? null, reason: (quote as { reason?: string } | null)?.reason ?? null })));
});