import { z } from "zod";
import { parseBody, protectedRoute, serialize } from "@/lib/api";
import { refreshPreparedTrade } from "@/services/trading";

// Only an id is accepted: the quote and transaction are rebuilt server-side from the stored, validated trade.
const body = z.object({ tradeId: z.string().min(1), wallet: z.string().min(20).max(64).optional() });

/** Rebuilds a queued LIVE trade's quote + unsigned transaction right before the user's wallet signs it. Signs nothing. */
export const POST = protectedRoute(
  async ({ req, user }) => {
    const { tradeId, wallet } = await parseBody(req, body);
    return serialize(await refreshPreparedTrade(user.id, tradeId, wallet));
  },
  { limit: { max: 30, windowMs: 60_000, key: "refresh" } },
);
