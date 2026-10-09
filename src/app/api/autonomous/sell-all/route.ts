import { protectedRoute, serialize } from "@/lib/api";
import { sellAllBotPositions } from "@/services/autonomous";

/** Sell every open position of the bot wallet at market, now (the server signs). */
export const POST = protectedRoute(async ({ user }) => serialize(await sellAllBotPositions(user.id)), { limit: { max: 5, windowMs: 60_000, key: "botwallet-sellall" } });
