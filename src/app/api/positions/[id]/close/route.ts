import { z } from "zod";
import { ApiError, parseBody, protectedRoute, serialize } from "@/lib/api";
import { collections } from "@/lib/db";
import { botSell, isBotPosition } from "@/services/autonomous";
import { prepareLiveSell } from "@/services/trading";

const body = z.object({
  percent: z.number().min(1).max(100).default(100),
  /** the address the browser is connected with: used if the wallet that bought is no longer linked */
  wallet: z.string().min(20).max(64).optional(),
});

/** Manual close. Produces a PREPARED sell that the user's wallet must sign — this endpoint can never move funds by itself. */
export const POST = protectedRoute<{ id: string }>(
  async ({ req, user, params }) => {
    const { percent, wallet } = await parseBody(req, body);
    const positions = await collections.positions();
    const pos = await positions.findOne({ _id: params.id, userId: user.id });
    if (!pos || pos.status === "CLOSED") throw new ApiError("Position not found or already closed", 404);
    const amount = pos.amount * (percent / 100);
    // a position held in the bot wallet is sold by the server: there is no signature for the user's own wallet to give
    if (await isBotPosition(user.id, pos)) {
      const r = await botSell(user.id, pos._id, amount, "MANUAL_EXIT", `Manual close (${percent}%)`);
      if (!r.ok && r.status === "FAILED") return serialize({ ok: false, reason: r.reason ?? "The sale could not be sent" });
      return serialize({ ok: true, awaitingSignature: false, sentByBot: true });
    }
    const r = await prepareLiveSell(user.id, pos._id, amount, "MANUAL_EXIT", `Manual close (${percent}%)`, undefined, wallet);
    return serialize({ ok: true, awaitingSignature: true, tradeId: r.trade.id });
  },
  { limit: { max: 30, windowMs: 60_000, key: "close" } },
);
