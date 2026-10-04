import { protectedRoute } from "@/lib/api";
import { markNotificationsRead } from "@/services/notifications";

export const POST = protectedRoute(async ({ user }) => {
  await markNotificationsRead(user.id);
  return { ok: true };
});
