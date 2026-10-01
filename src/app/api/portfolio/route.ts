import { protectedRoute, serialize } from "@/lib/api";
import { portfolio } from "@/services/queries";

export const GET = protectedRoute(async ({ user }) => {
  return serialize(await portfolio(user.id, "LIVE"));
});