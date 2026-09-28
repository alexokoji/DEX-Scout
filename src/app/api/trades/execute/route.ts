import { z } from "zod";
import { parseBody, protectedRoute, serialize } from "@/lib/api";
import { executeTrade } from "@/services/trading";

// Only an id (+ wallet signature for LIVE) is accepted: amounts and prices come from the stored, validated Trade.
const body = z.object({ tradeId: z.string().min(1), signature: z.string().max(120).optional() });

export const POST = protectedRoute(
  async ({ req, user }) => {
    const { tradeId, signature } = await parseBody(req, body);
    return serialize(await executeTrade(user.id, tradeId, { signature }));
  },
  { limit: { max: 30, windowMs: 60_000, key: "execute" } },
);