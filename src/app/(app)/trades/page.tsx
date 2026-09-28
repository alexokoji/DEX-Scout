import { LiveRefresh } from "@/components/features/LiveRefresh";
import { PageHeader } from "@/components/features/PageHeader";
import { PendingApprovals } from "@/components/features/PendingApprovals";
import { Badge, EnvBadge, PnL } from "@/components/ui/badges";
import { Card, CardHeader, EmptyState } from "@/components/ui/card";
import { providers } from "@/core/providers/registry";
import { requireUser } from "@/lib/auth";
import { db } from "@/lib/db";
import { price, shortAddr, timeAgo, usd } from "@/lib/format";

const STATUS_TONE = { CONFIRMED: "green", FAILED: "red", PENDING: "amber", PREPARED: "blue", EXPIRED: "gray", CANCELLED: "gray" } as const;

export default async function TradesPage() {
  const user = await requireUser();
  const trades = await db.trade.findMany({
    where: { userId: user.id },
    orderBy: { createdAt: "desc" },
    take: 200,
    include: { token: { select: { symbol: true, chain: true } }, transaction: { select: { signature: true } } },
  });
  const explorers = providers().chains;
  return (
    <div className="space-y-4">
      <PageHeader title="Trades" subtitle="Paper trades are simulations and never have a transaction signature. Only LIVE trades link to the chain." right={<LiveRefresh seconds={15} />} />
      <PendingApprovals />
      <Card>
        <CardHeader title="History" />
        {trades.length === 0 ? (
          <EmptyState title="No trades yet" />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[820px] text-sm">
              <thead className="border-b border-border text-left text-[11px] uppercase tracking-wider text-muted">
                <tr>{["Time", "Token", "Side", "Kind", "Env", "Amount", "Price", "Impact", "Fees", "P/L", "Status", "Tx"].map((h) => <th key={h} className="px-3 py-2 font-semibold">{h}</th>)}</tr>
              </thead>
              <tbody>
                {trades.map((t) => (
                  <tr key={t.id} className="border-b border-border/60 hover:bg-surface2">
                    <td className="px-3 py-2 text-xs text-muted">{timeAgo(t.createdAt)}</td>
                    <td className="px-3 py-2 font-medium">{t.token.symbol} <span className="text-[11px] text-muted">{t.token.chain}</span></td>
                    <td className="px-3 py-2"><Badge tone={t.side === "BUY" ? "green" : "red"}>{t.side}</Badge></td>
                    <td className="px-3 py-2 text-xs">{t.kind.replace("_", " ")}</td>
                    <td className="px-3 py-2"><EnvBadge env={t.environment} source={t.dataSource} /></td>
                    <td className="num px-3 py-2">{usd(t.inputUsd)}</td>
                    <td className="num px-3 py-2">{price(t.priceUsd)}</td>
                    <td className="num px-3 py-2">{t.priceImpactPct.toFixed(2)}%</td>
                    <td className="num px-3 py-2">{usd(t.feesUsd + t.networkFeeUsd, 3)}</td>
                    <td className="px-3 py-2">{t.realizedPnlUsd != null ? <PnL value={t.realizedPnlUsd} /> : <span className="text-muted">—</span>}</td>
                    <td className="px-3 py-2">
                      <Badge tone={STATUS_TONE[t.status]}>{t.status}</Badge>
                      {t.failureReason && <div className="mt-0.5 max-w-[200px] truncate text-[11px] text-down" title={t.failureReason}>{t.failureReason}</div>}
                    </td>
                    <td className="px-3 py-2 text-xs">
                      {t.transaction?.signature ? <a className="text-accent" target="_blank" rel="noreferrer" href={explorers[t.token.chain as keyof typeof explorers].explorerTxUrl(t.transaction.signature)}>{shortAddr(t.transaction.signature)}</a> : <span className="text-muted">{t.environment === "PAPER" ? "simulated" : "—"}</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}