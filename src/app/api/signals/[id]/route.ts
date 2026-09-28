import { ApiError, protectedRoute, serialize } from "@/lib/api";
import { db } from "@/lib/db";

export const GET = protectedRoute<{ id: string }>(async ({ params }) => {
  const s = await db.signal.findUnique({ where: { id: params.id }, include: { token: true, analysis: true } });
  if (!s) throw new ApiError("Signal not found", 404);
  return serialize(s);
});
