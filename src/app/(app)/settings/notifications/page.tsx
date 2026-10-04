import { NotificationsPanel } from "@/components/features/NotificationsPanel";
import { PageHeader } from "@/components/features/PageHeader";
import { requireUser } from "@/lib/auth";
import { getNotificationPrefs } from "@/services/notifications";

export const dynamic = "force-dynamic";

export default async function NotificationsPage() {
  const user = await requireUser();
  return (
    <div className="space-y-4">
      <PageHeader title="Notifications" subtitle="Get told when a profit-target sell is queued. The bot can't sign for you, so the sell waits until you approve it in your wallet." />
      <NotificationsPanel initial={await getNotificationPrefs(user.id)} />
    </div>
  );
}
