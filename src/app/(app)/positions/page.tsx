import { LiveRefresh } from "@/components/features/LiveRefresh";
import { NoStopLossNotice } from "@/components/features/NoStopLossNotice";
import { PageHeader } from "@/components/features/PageHeader";
import { PositionsView } from "@/components/features/PositionsView";
import { Card, CardHeader } from "@/components/ui/card";
import { requireUser } from "@/lib/auth";
import { collections, withIds } from "@/lib/db";
import { positionViews } from "@/services/queries";
import { timeAgo } from "@/lib/format";

export default async function PositionsPage() {
  const user = await requireUser();
  const positionsCol = await collections.positions();
  const positionEventsCol = await collections.positionEvents();
  const tokensCol = await collections.tokens();

  const [all, myPositions] = await Promise.all([
    positionViews(user.id, undefined, true),
    positionsCol.find({ userId: user.id }, { projection: { _id: 1, tokenId: 1 } }).toArray(),
  ]);
  const tokenIdByPosition = new Map(myPositions.map((p) => [p._id, p.tokenId]));
  const events = withIds(
    await positionEventsCol.find({ positionId: { $in: [...tokenIdByPosition.keys()] } }).sort({ createdAt: -1 }).limit(15).toArray(),
  );
  const tokenSymbols = new Map(
    (await tokensCol.find({ _id: { $in: [...new Set(events.map((e) => tokenIdByPosition.get(e.positionId)).filter((x): x is string => !!x))] } }, { projection: { _id: 1, symbol: 1 } }).toArray()).map((t) => [t._id, t.symbol]),
  );

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
              <span><span className="font-medium">{tokenSymbols.get(tokenIdByPosition.get(e.positionId) ?? "") ?? "?"}</span> · {e.message}</span>
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
