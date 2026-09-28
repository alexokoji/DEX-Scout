import Link from "next/link";
import { PageHeader } from "@/components/features/PageHeader";
import { PositionsView } from "@/components/features/PositionsView";
import { EnvBadge } from "@/components/ui/badges";
import { Card, CardHeader, Stat } from "@/components/ui/card";
import { requireUser } from "@/lib/auth";
import { usd } from "@/lib/format";
import { portfolio, positionViews } from "@/services/queries";

export default async function PortfolioPage({ searchParams }: { searchParams: Promise<{ env?: string }> }) {
  const user = await requireUser();
  const sp = await searchParams;
  const env = sp.env === "LIVE" ? "LIVE" : "PAPER";
  const [pf, positions] = await Promise.all([portfolio(user.id, env), positionViews(user.id, env)]);
  const total = pf.capital.availableUsd + pf.openPositionValueUsd;
  return (
    <div className="space-y-4">
      <PageHeader
        title="Portfolio"
        subtitle="Wallet balance, trading allocation, open position value and available capital are tracked separately."
        right={
          <div className="flex gap-1 text-xs">
            {(["PAPER", "LIVE"] as const).map((e) => (
              <Link key={e} href={`/portfolio?env=${e}`} className={`rounded px-3 py-1.5 ${env === e ? "bg-surface2 text-foreground" : "text-muted hover:text-foreground"}`}>{e}</Link>
            ))}
          </div>
        }
      />
      <div className="flex items-center gap-2 text-xs text-muted">Viewing <EnvBadge env={env} /></div>
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
        <Stat label="Connected wallet" value={pf.wallet?.balanceUsd != null ? usd(pf.wallet.balanceUsd) : "—"} sub={pf.wallet ? `${pf.wallet.summary || "no balance"} (not part of allocation)` : <Link href="/wallet" className="text-accent">Link a wallet</Link>} />
        <Stat label="Trading allocation" value={usd(pf.capital.capitalUsd)} sub="max the bot may use" />
        <Stat label="Open position value" value={usd(pf.openPositionValueUsd)} sub={`${pf.positions} positions`} />
        <Stat label="Available capital" value={usd(pf.capital.availableUsd)} sub={`${usd(pf.capital.deployedUsd)} deployed`} />
        <Stat label="Unrealized P/L" value={usd(pf.unrealizedPnlUsd)} tone={pf.unrealizedPnlUsd >= 0 ? "up" : "down"} />
        <Stat label="Realized P/L" value={usd(pf.realizedPnlUsd)} tone={pf.realizedPnlUsd >= 0 ? "up" : "down"} sub={`Est. equity ${usd(total)}`} />
      </div>
      <Card>
        <CardHeader title="Open positions" />
        <PositionsView positions={positions as never} />
      </Card>
    </div>
  );
}