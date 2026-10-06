import Link from "next/link";
import { PageHeader } from "@/components/features/PageHeader";
import { PositionsView } from "@/components/features/PositionsView";
import { Card, CardHeader, Stat } from "@/components/ui/card";
import { requireUser } from "@/lib/auth";
import { usd, usdPnl } from "@/lib/format";
import { portfolio, positionViews } from "@/services/queries";

export default async function PortfolioPage() {
  const user = await requireUser();
  const env = "LIVE" as const;
  const [pf, positions] = await Promise.all([portfolio(user.id, env), positionViews(user.id, env)]);
  const total = (pf.capital.walletUsd ?? 0) + pf.openPositionValueUsd;
  return (
    <div className="space-y-4">
      <PageHeader
        title="Portfolio"
        subtitle="Your wallet balance is your capital. Open position value and what is still available to trade are tracked separately."
      />
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-5">
        <Stat label="Connected wallet" value={pf.wallet?.balanceUsd != null ? usd(pf.wallet.balanceUsd) : "—"} sub={pf.wallet ? pf.wallet.summary || "no balance" : <Link href="/wallet" className="text-accent">Link a wallet</Link>} />
        <Stat label="Open position value" value={usd(pf.openPositionValueUsd)} sub={`${pf.positions} positions`} />
        <Stat label="Available to trade" value={pf.capital.availableUsd !== null ? usd(pf.capital.availableUsd) : "—"} sub={`${usd(pf.capital.deployedUsd)} deployed`} />
        <Stat label="Unrealized P/L" value={usdPnl(pf.unrealizedPnlUsd)} tone={pf.unrealizedPnlUsd >= 0 ? "up" : "down"} />
        <Stat label="Realized P/L" value={usdPnl(pf.realizedPnlUsd)} tone={pf.realizedPnlUsd >= 0 ? "up" : "down"} sub={`Est. equity ${usd(total)}`} />
      </div>
      <Card>
        <CardHeader title="Open positions" />
        <PositionsView positions={positions as never} />
      </Card>
    </div>
  );
}