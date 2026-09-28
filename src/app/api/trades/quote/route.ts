import { parseBody, protectedRoute, serialize } from "@/lib/api";
import { prepareTradeInput, quoteTrade } from "@/services/trading";

/** Read-only: returns a quote plus every rule the trade currently violates. Nothing is stored or signed. */
export const POST = protectedRoute(
  async ({ req, user }) => {
    const input = await parseBody(req, prepareTradeInput);
    const r = await quoteTrade(user.id, input);
    return serialize({ ...r, quote: { ...r.quote, raw: undefined } });
  },
  { limit: { max: 60, windowMs: 60_000, key: "quote" } },
);
