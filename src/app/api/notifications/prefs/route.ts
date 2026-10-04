import { parseBody, protectedRoute } from "@/lib/api";
import { getNotificationPrefs, notificationPrefsInput, saveNotificationPrefs } from "@/services/notifications";

export const GET = protectedRoute(async ({ user }) => getNotificationPrefs(user.id));

export const PUT = protectedRoute(
  async ({ req, user }) => saveNotificationPrefs(user.id, await parseBody(req, notificationPrefsInput)),
  { limit: { max: 20, windowMs: 60_000, key: "notify-prefs" } },
);
