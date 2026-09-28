import Link from "next/link";
import { LiveRefresh } from "@/components/features/LiveRefresh";
import { PageHeader } from "@/components/features/PageHeader";
import { Badge } from "@/components/ui/badges";
import { Card, EmptyState } from "@/components/ui/card";
import { requireUser } from "@/lib/auth";
import { db } from "@/lib/db";
import { clockTime, timeAgo } from "@/lib/format";

const TYPES = ["SCANNER_COMPLETED", "TOKEN_DISCOVERED", "SAFETY_CHECK_COMPLETED", "SIGNAL_CREATED", "SIGNAL_EXPIRED", "TRADE_REQUESTED", "TRADE_EXECUTED", "TRADE_FAILED", "TRADE_SKIPPED", "POSITION_OPENED", "TARGET_REACHED", "PROFIT_TAKEN", "EMERGENCY_WARNING", "EMERGENCY_EXIT", "POSITION_CLOSED", "PROVIDER_ERROR", "WORKER_ERROR"];

export default async function ActivityPage({ searchParams }: { searchParams: Promise<{ type?: string; level?: string }> }) {
  const user = await requireUser();
  const sp = await searchParams;
  const events = await db.systemEvent.findMany({
    where: { OR: [{ userId: user.id }, { userId: null }], ...(sp.type ? { type: sp.type } : {}), ...(sp.level === "WARN" || sp.level === "ERROR" ? { level: sp.level } : {}) },
    orderBy: { ts: "desc" },
    take: 200,
  });
  const chip = (label: string, q: string, active: boolean) => (
    <Link key={label} href={q ? `/activity?${q}` : "/activity"} className={`rounded px-2 py-1 text-[11px] ${active ? "bg-accent text-white" : "bg-surface2 text-muted hover:text-foreground"}`}>{label}</Link>
  );
  return (
    <div className="space-y-4">
      <PageHeader title="Activity log" subtitle="Every scanner, engine, bot and trade event, for debugging and transparency." right={<LiveRefresh seconds={10} />} />
      <div className="flex flex-wrap gap-1.5">
        {chip("All", "", !sp.type && !sp.level)}
        {chip("Warnings", "level=WARN", sp.level === "WARN")}
        {chip("Errors", "level=ERROR", sp.level === "ERROR")}
        {TYPES.map((t) => chip(t, `type=${t}`, sp.type === t))}
      </div>
      <Card>
        {events.length === 0 ? (
          <EmptyState title="No events match" />
        ) : (
          <div className="divide-y divide-border/60">
            {events.map((e) => (
              <div key={e.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2 text-xs">
                <span className="num text-muted" title={e.ts.toISOString()}>{clockTime(e.ts)} · {timeAgo(e.ts)}</span>
                <Badge tone={e.level === "ERROR" ? "red" : e.level === "WARN" ? "amber" : e.level === "DEBUG" ? "gray" : "blue"}>{e.type}</Badge>
                <span className="text-muted">{e.source}</span>
                <span className={e.level === "ERROR" ? "text-down" : ""}>{e.message}</span>
              </div>
            ))}
          </div>
        )}
      </Card>
    </div>
  );
}