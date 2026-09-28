import { ApiError, protectedRoute, serialize } from "@/lib/api";
import { collections, withId } from "@/lib/db";

export const GET = protectedRoute<{ id: string }>(async ({ params }) => {
  const signals = await collections.signals();
  const s = await signals.findOne({ _id: params.id });
  if (!s) throw new ApiError("Signal not found", 404);
  const tokens = await collections.tokens();
  const token = await tokens.findOne({ _id: s.tokenId });
  return serialize({ ...withId(s), token: token ? withId(token) : null });
});
