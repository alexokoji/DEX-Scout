import { protectedRoute, serialize } from "@/lib/api";
import { portfolio } from "@/services/queries";

export const GET = protectedRoute(async ({ req, user }) => {
  const env = new URL(req.url).searchParams.get("environment");
  return serialize(await portfolio(user.id, env === "LIVE" ? "LIVE" : "PAPER"));
});