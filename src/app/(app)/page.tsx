import Link from "next/link";
import { LiveRefresh } from "@/components/features/LiveRefresh";
import { PageHeader } from "@/components/features/PageHeader";
import { Badge, Change, EnvBadge, PnL, RiskBadge, ScoreBar, SignalBadge } from "@/components/ui/badges";
import { Card, CardBody, CardHeader, EmptyState, Stat } from "@/components/ui/card";
import { requireUser } from "@/lib/auth";
import { clockTime, compactUsd, price, timeAgo, usd, usdPnl } from "@/lib/format";
import { dashboard } from "@/services/queries";

export default async function DashboardPage() {
  const user = await requireUser();
  const d = await dashboard(user.id);
  const botStatus = d.bot?.status ?? "PAUSED";
  const scannerAlive = d.workers.find((w) => w.name === "scanner-worker")?.alive;
  const pf = d.pf;

  return (
    <div className="space-y-4">
      <PageHeader title="Dashboard" subtitle={`Environment: ${d.env} · ${d.tokenCount} tokens tracked, ${d.passing} passing filters`} right={<LiveRefresh seconds={15} />} />

      <div className="grid grid-cols-2 gap-3 md:grid-cols-4 xl:grid-cols-6">
        <Stat label="Wallet balance" value={pf.wallet?.balanceUsd != null ? usd(pf.wallet.balanceUsd) : "—"} sub={pf.wallet ? pf.wallet.summary || "no balance" : <Link href="/wallet" className="text-accent">Connect wallet</Link>} />
        <Stat label="Available to trade" value={pf.capital.availableUsd !== null ? usd(pf.capital.availableUsd) : "—"} sub={pf.wallet ? `${usd(pf.capital.deployedUsd)} deployed` : "connect a wallet"} />
        <Stat label="Open positions" value={String(pf.positions)} sub={`${pf.capital.slotsLeft} slots left`} />
        <Stat label="Realized P/L" value={usdPnl(pf.realizedPnlUsd)} tone={pf.realizedPnlUsd > 0 ? "up" : pf.realizedPnlUsd < 0 ? "down" : undefined} />
        <Stat label="Unrealized P/L" value={usdPnl(pf.unrealizedPnlUsd)} tone={pf.unrealizedPnlUsd > 0 ? "up" : pf.unrealizedPnlUsd < 0 ? "down" : undefined} />
        <Stat label="Signals today" value={String(d.todaySignals)} sub={`${d.activeSignals} active now`} />
        <Stat label="Trades today" value={String(d.tradesToday)} />
        <Stat label="Bot" value={botStatus} tone={botStatus === "ACTIVE" ? "up" : botStatus === "DISABLED" ? "down" : "warn"} sub={d.settings.autoTradingEnabled ? "Auto trading ON" : "Manual mode"} />
        <Stat label="Scanner" value={scannerAlive ? "RUNNING" : "OFFLINE"} tone={scannerAlive ? "up" : "down"} sub={scannerAlive ? "workers healthy" : "start workers: npm run workers"} />
        <Stat label="Avg 1h change" value={`${(d.market._avg.change1h ?? 0).toFixed(2)}%`} sub="qualifying tokens" />
        <Stat label="24h volume" value={compactUsd(d.market._sum.volume24hUsd ?? 0)} sub="qualifying tokens" />
      </div>

      <div className="grid gap-4 xl:grid-cols-2">
        <Card>
          <CardHeader title="Top active signals" right={<Link href="/signals" className="text-xs text-accent">View all</Link>} />
          {d.recentSignals.length === 0 ? (
            <EmptyState title="No active signals yet" hint="The scanner and signal workers are warming up. Make sure `npm run dev` (or `npm run workers`) is running." />
          ) : (
            <div className="divide-y divide-border">
              {d.recentSignals.map((s) => (
                <Link key={s.id} href={`/tokens/${s.token.address}?chain=${s.token.chain}`} className="flex items-center justify-between gap-3 px-4 py-2.5 hover:bg-surface2">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2 font-medium">{s.token.symbol} <SignalBadge type={s.type} /></div>
                    <div className="text-[11px] text-muted">{compactUsd(s.token.marketCapUsd)} mcap · {compactUsd(s.token.liquidityUsd)} liq · {timeAgo(s.createdAt)}</div>
                  </div>
                  <div className="flex items-center gap-3">
                    <Change value={s.token.change1h} />
                    <ScoreBar score={s.score} />
                    <RiskBadge level={s.riskLevel} />
                  </div>
                </Link>
              ))}
            </div>
          )}
        </Card>

        <Card>
          <CardHeader title="Open positions" right={<Link href="/positions" className="text-xs text-accent">View all</Link>} />
          {d.positions.length === 0 ? (
            <EmptyState title="No open positions" hint="Open one manually from a token page (paper trading), or enable the bot." />
          ) : (
            <div className="divide-y divide-border">
              {d.positions.map((p) => (
                <Link key={p.id} href="/positions" className="flex items-center justify-between px-4 py-2.5 hover:bg-surface2">
                  <div>
                    <div className="flex items-center gap-2 font-medium">{p.token.symbol} <EnvBadge env={p.environment} /></div>
                    <div className="text-[11px] text-muted">entry {price(p.entryPriceUsd)} → {price(p.currentPriceUsd)}</div>
                  </div>
                  <PnL value={p.metrics.pricePnlUsd} pct={p.metrics.pricePnlPct} />
                </Link>
              ))}
            </div>
          )}
        </Card>

        <Card>
          <CardHeader title="Recent transactions" right={<Link href="/trades" className="text-xs text-accent">View all</Link>} />
          {d.recentTrades.length === 0 ? (
            <EmptyState title="No trades yet" />
          ) : (
            <div className="divide-y divide-border">
              {d.recentTrades.map((t) => (
                <div key={t.id} className="flex items-center justify-between px-4 py-2.5">
                  <div className="flex items-center gap-2">
                    <Badge tone={t.side === "BUY" ? "green" : "red"}>{t.side}</Badge>
                    <span className="font-medium">{t.token.symbol}</span>
                    <EnvBadge env={t.environment} source={t.dataSource} />
                  </div>
                  <div className="text-right text-xs">
                    <div className="num">{usd(t.inputUsd)}</div>
                    <div className={t.status === "FAILED" ? "text-down" : "text-muted"}>{t.status} · {timeAgo(t.createdAt)}</div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </Card>

        <Card>
          <CardHeader title="System activity" sub="Latest events from workers and engines" />
          <CardBody className="space-y-1.5 p-3">
            {d.events.map((e) => (
              <div key={e.id} className="flex gap-2 text-xs">
                <span className="num shrink-0 text-muted">{clockTime(e.ts)}</span>
                <span className={e.level === "ERROR" ? "text-down" : e.level === "WARN" ? "text-warn" : ""}>{e.message}</span>
              </div>
            ))}
            {d.events.length === 0 && <div className="text-xs text-muted">No events yet.</div>}
          </CardBody>
        </Card>
      </div>

      <Card>
        <CardHeader title="Background workers" />
        <div className="grid gap-px bg-border sm:grid-cols-2 lg:grid-cols-5">
          {d.workers.map((w) => (
            <div key={w.name} className="bg-surface p-3 text-xs">
              <div className="flex items-center gap-2 font-medium">
                <span className={`h-2 w-2 rounded-full ${w.alive ? "pulse-dot bg-up" : "bg-down"}`} />
                {w.name}
              </div>
              <div className="mt-1 text-muted">{w.lastRunAt ? `last run ${timeAgo(w.lastRunAt)}` : "never ran"} · {w.runs} runs</div>
              {w.lastError && <div className="mt-1 truncate text-down">{w.lastError}</div>}
            </div>
          ))}
        </div>
      </Card>
    </div>
  );
}
