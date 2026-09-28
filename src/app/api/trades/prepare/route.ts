import { parseBody, protectedRoute, serialize } from "@/lib/api";
import { prepareTrade, prepareTradeInput } from "@/services/trading";

/** Validates server-side and stores a PREPARED trade. The client never supplies price/limits that are trusted. */
export const POST = protectedRoute(
  async ({ req, user }) => {
    const input = await parseBody(req, prepareTradeInput);
    const r = await prepareTrade(user.id, input);
    return serialize({
      tradeId: r.trade.id,
      expiresAt: r.trade.expiresAt,
      environment: r.trade.environment,
      quote: { ...r.quote, raw: undefined },
      // LIVE only: unsigned transaction for the user's wallet to sign. PAPER trades have none.
      unsignedTxBase64: r.unsignedTxBase64,
    });
  },
  { limit: { max: 30, windowMs: 60_000, key: "prepare" } },
);