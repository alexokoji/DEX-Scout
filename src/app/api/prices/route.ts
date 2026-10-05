import { protectedRoute, serialize } from "@/lib/api";
import { livePrices } from "@/services/livePrices";

/** Live prices for the tokens on screen: `?tokens=chain:address,chain:address` (up to 30). See services/livePrices.ts. */
export const GET = protectedRoute(async ({ req }) => serialize({ prices: await livePrices(new URL(req.url).searchParams.get("tokens") ?? "") }), {
  limit: { max: 90, windowMs: 60_000, key: "prices" },
});
