import { protectedRoute, serialize } from "@/lib/api";
import { collections, withIds } from "@/lib/db";
import { attachTokens } from "@/services/queries";

export const GET = protectedRoute(async ({ req, user }) => {
  const sp = new URL(req.url).searchParams;
  const status = sp.get("status");
  const trades = await collections.trades();
  const raw = withIds(
    await trades
      .find({ userId: user.id, ...(status ? { status: status as never } : {}) })
      .sort({ createdAt: -1 })
      .limit(Math.min(500, Number(sp.get("limit") ?? 100)))
      .toArray(),
  );
  const withToken = await attachTokens(raw);
  // unsigned payloads and provider quote internals are not needed by list consumers
  return serialize(
    withToken.map(({ quote, token, ...t }) => ({ ...t, token: { symbol: token.symbol, address: token.address }, quote: undefined, reason: (quote as { reason?: string } | null)?.reason ?? null })),
  );
});
