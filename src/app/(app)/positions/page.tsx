import { LiveRefresh } from "@/components/features/LiveRefresh";
import { NoStopLossNotice } from "@/components/features/NoStopLossNotice";
import { PageHeader } from "@/components/features/PageHeader";
import { PositionsView } from "@/components/features/PositionsView";
import { Card, CardHeader } from "@/components/ui/card";
import { requireUser } from "@/lib/auth";
import { db } from "@/lib/db";
import { positionViews } from "@/services/queries";
import { timeAgo } from "@/lib/format";

export default async function PositionsPage() {
  const user = await requireUser();
  const [all, events] = await Promise.all([
    positionViews(user.id, undefined, true),
    db.positionEvent.findMany({ where: { position: { userId: user.id } }, orderBy: { createdAt: "desc" }, take: 15, include: { position: { include: { token: { select: { symbol: true } } } } } }),
  ]);
  const open = all.filter((p) => p.status !== "CLOSED");
  const closed = all.filter((p) => p.status === "CLOSED");
  return (
    <div className="space-y-4">
      <PageHeader title="Positions" subtitle="Every open position is re-analysed continuously by the position monitor worker." right={<LiveRefresh seconds={10} />} />
      <NoStopLossNotice />
      <Card>
        <CardHeader title={`Open (${open.length})`} />
        <PositionsView positions={open as never} />
      </Card>
      <Card>
        <CardHeader title="Recent position events" />
        <div className="divide-y divide-border">
          {events.map((e) => (
            <div key={e.id} className="flex items-center justify-between gap-3 px-4 py-2 text-xs">
              <span><span className="font-medium">{e.position.token.symbol}</span> · {e.message}</span>
              <span className="shrink-0 text-muted">{timeAgo(e.createdAt)}</span>
            </div>
          ))}
          {!events.length && <div className="px-4 py-6 text-center text-xs text-muted">No events yet.</div>}
        </div>
      </Card>
      {closed.length > 0 && (
        <Card>
          <CardHeader title={`Closed (${closed.length})`} />
          <PositionsView positions={closed as never} actions={false} />
        </Card>
      )}
    </div>
  );
}