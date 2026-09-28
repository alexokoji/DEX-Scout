import { z } from "zod";
import { ApiError, parseBody, protectedRoute, serialize } from "@/lib/api";
import { collections } from "@/lib/db";
import { paperSell, prepareLiveSell } from "@/services/trading";

const body = z.object({ percent: z.number().min(1).max(100).default(100) });

/**
 * Manual close. PAPER positions are sold immediately (simulated). LIVE positions produce a PREPARED sell that the
 * user's wallet must sign — this endpoint can never move funds by itself.
 */
export const POST = protectedRoute<{ id: string }>(
  async ({ req, user, params }) => {
    const { percent } = await parseBody(req, body);
    const positions = await collections.positions();
    const pos = await positions.findOne({ _id: params.id, userId: user.id });
    if (!pos || pos.status === "CLOSED") throw new ApiError("Position not found or already closed", 404);
    const amount = pos.amount * (percent / 100);
    if (pos.environment === "PAPER") return serialize(await paperSell(user.id, pos._id, amount, "MANUAL_EXIT", `Manual close (${percent}%)`));
    const r = await prepareLiveSell(user.id, pos._id, amount, "MANUAL_EXIT", `Manual close (${percent}%)`);
    return serialize({ ok: true, awaitingSignature: true, tradeId: r.trade.id });
  },
  { limit: { max: 30, windowMs: 60_000, key: "close" } },
);
