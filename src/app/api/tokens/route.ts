import { protectedRoute, serialize } from "@/lib/api";
import { listTokens, tokenQuerySchema } from "@/services/queries";

export const GET = protectedRoute(async ({ req }) => {
  const q = tokenQuerySchema.parse(Object.fromEntries(new URL(req.url).searchParams));
  return serialize(await listTokens(q));
});
