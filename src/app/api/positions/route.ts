import { protectedRoute, serialize } from "@/lib/api";
import { positionViews } from "@/services/queries";

export const GET = protectedRoute(async ({ req, user }) => {
  const sp = new URL(req.url).searchParams;
  const env = sp.get("environment");
  return serialize(await positionViews(user.id, env === "LIVE" ? env : undefined, sp.get("closed") === "true"));
});
