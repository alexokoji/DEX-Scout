import { protectedRoute, serialize } from "@/lib/api";
import { listNotifications } from "@/services/notifications";

/** The bell: latest notifications and the unread count. Polled by the header while the app is open. */
export const GET = protectedRoute(async ({ user }) => serialize(await listNotifications(user.id)));
