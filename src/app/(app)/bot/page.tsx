import Link from "next/link";
import { BotControls } from "@/components/features/BotControls";
import { LiveRefresh } from "@/components/features/LiveRefresh";
import { NoStopLossNotice } from "@/components/features/NoStopLossNotice";
import { PageHeader } from "@/components/features/PageHeader";
import { Badge, EnvBadge } from "@/components/ui/badges";
import { Card, CardBody, CardHeader, Stat } from "@/components/ui/card";
import { requireUser } from "@/lib/auth";
import { clockTime, timeAgo, usd, usdPnl } from "@/lib/format";
import { autonomousStatus } from "@/services/autonomous";
import { botOverview } from "@/services/queries";
import { workerStatuses } from "@/services/workerState";

export default async function BotPage() {
  const user = await requireUser();
  const [o, workers] = await Promise.all([botOverview(user.id), workerStatuses()]);
  const auto = o.settings.autonomous.enabled ? await autonomousStatus(user.id, o.settings).catch(() => null) : null;
  const status = o.bot?.status ?? "PAUSED";
  const s = o.settings;
  const alive = workers.find((w) => w.name === "trade-executor-worker")?.alive;
  return (
    <div className="space-y-4">
      <PageHeader title="Bot" subtitle="Automated trading engine. The bot only trades deterministic-rule-approved BUY signals within your limits." right={<LiveRefresh seconds={10} />} />
      <NoStopLossNotice />
      <Card>
        <CardBody className="flex flex-wrap items-center justify-between gap-3 text-sm">
          <div>
            <div className="flex items-center gap-2 font-medium">Unattended trading {auto ? <Badge tone={auto.decision.canOpen ? "green" : "amber"}>{auto.decision.state.replace("_", " ").toLowerCase()}</Badge> : <Badge>off</Badge>}</div>
            <div className="mt-0.5 text-xs text-muted">{auto ? auto.decision.reason : "The bot asks you to sign each trade. Turn this on to let it trade with its own wallet toward a daily profit target, inside a daily loss limit."}</div>
          </div>
          <Link href="/settings/autonomous" className="text-xs text-accent">{auto ? "Open" : "Set up"}</Link>
        </CardBody>
      </Card>
      <Card>
        <CardBody className="flex flex-wrap items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <span className={`h-3 w-3 rounded-full ${status === "ACTIVE" ? "pulse-dot bg-up" : status === "DISABLED" ? "bg-down" : "bg-warn"}`} />
            <div>
              <div className="text-lg font-semibold">{status}</div>
              <div className="flex items-center gap-2 text-xs text-muted">
                <EnvBadge env={o.env} /> {s.autoTradingEnabled ? "auto trading on" : "auto trading off"} · last run {o.bot?.lastRunAt ? timeAgo(o.bot.lastRunAt) : "never"}
                {!alive && status === "ACTIVE" && <Badge tone="red">executor worker offline</Badge>}
              </div>
            </div>
          </div>
          <BotControls status={status} />
        </CardBody>
      </Card>

      <div className="grid grid-cols-2 gap-3 md:grid-cols-4 xl:grid-cols-6">
        <Stat label="Wallet balance" value={o.pf.capital.walletUsd !== null ? usd(o.pf.capital.walletUsd) : "—"} />
        <Stat label="Available" value={o.pf.capital.availableUsd !== null ? usd(o.pf.capital.availableUsd) : "—"} />
        <Stat label="Open positions" value={`${o.pf.positions} / ${s.maxOpenPositions}`} />
        <Stat label="Trades today" value={String(o.tradesToday)} />
        <Stat label="Realized P/L" value={usdPnl(o.pf.realizedPnlUsd)} tone={o.pf.realizedPnlUsd >= 0 ? "up" : "down"} />
        <Stat label="Unrealized P/L" value={usdPnl(o.pf.unrealizedPnlUsd)} tone={o.pf.unrealizedPnlUsd >= 0 ? "up" : "down"} />
        <Stat label="Signals evaluated" value={String(o.totals.signalsEvaluated ?? 0)} sub="all-time" />
        <Stat label="Trades executed" value={String(o.totals.tradesExecuted ?? 0)} sub="all-time" />
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader title="Configuration" right={<Link href="/settings/trading" className="text-xs text-accent">Edit</Link>} />
          <CardBody className="grid grid-cols-2 gap-x-6 gap-y-1.5 text-xs">
            {([
              ["Environment", s.environment], ["Max position", usd(s.maxPositionUsd)], ["Min position", usd(s.minPositionUsd)], ["Max open", String(s.maxOpenPositions)],
              ["Max deployed", s.maxDeployedUsd === null ? "wallet balance" : usd(s.maxDeployedUsd)], ["Min score", String(s.minOpportunityScore)], ["Min liquidity", usd(s.minLiquidityUsd, 0)], ["Min 24h volume", usd(s.minVolume24hUsd, 0)],
              ["Max price impact", `${s.maxPriceImpactPct}%`], ["Max risk", s.maxAllowedRisk], ["Min trust", s.minTrust], ["Profit targets", s.targets.map((t) => `+${t.gainPct}%/${t.sellPct >= 100 ? "rest" : t.sellPct + "%"}`).join(", ")],
              ["Emergency protection", s.emergencyEnabled ? (s.emergencyAutoExit ? "ON · auto exit" : "ON · alert only") : "OFF"],
            ] as [string, string][]).map(([k, v]) => (
              <div key={k} className="flex justify-between gap-2"><span className="text-muted">{k}</span><span className="num text-right">{v}</span></div>
            ))}
          </CardBody>
        </Card>

        <Card>
          <CardHeader title="Recent runs" />
          <div className="divide-y divide-border text-xs">
            {o.runs.map((r) => (
              <div key={r.id} className="flex items-center justify-between px-4 py-2">
                <span className="text-muted">{timeAgo(r.startedAt)}</span>
                <span className="num">{r.signalsEvaluated} evaluated · {r.tradesExecuted} executed · {r.tradesSkipped} skipped</span>
              </div>
            ))}
            {!o.runs.length && <div className="px-4 py-6 text-center text-muted">The bot has not run yet.</div>}
          </div>
        </Card>
      </div>

      <Card>
        <CardHeader title="Recent bot events" />
        <CardBody className="space-y-1.5 p-3">
          {o.events.map((e) => (
            <div key={e.id} className="flex gap-2 text-xs">
              <span className="num shrink-0 text-muted">{clockTime(e.ts)}</span>
              <Badge tone={e.level === "ERROR" ? "red" : e.level === "WARN" ? "amber" : "gray"}>{e.type}</Badge>
              <span>{e.message}</span>
            </div>
          ))}
          {!o.events.length && <div className="text-xs text-muted">No events yet.</div>}
        </CardBody>
      </Card>
    </div>
  );
}