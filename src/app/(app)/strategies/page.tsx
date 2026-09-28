import Link from "next/link";
import { PageHeader } from "@/components/features/PageHeader";
import { Badge } from "@/components/ui/badges";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { requireUser } from "@/lib/auth";
import { compactUsd } from "@/lib/format";
import { getSettings } from "@/services/settings";
import { db } from "@/lib/db";
import { BacktestPanel } from "@/components/features/BacktestPanel";

export default async function StrategiesPage() {
  const user = await requireUser();
  const s = await getSettings(user.id);
  const btTokens = await db.token.findMany({ where: { passedFilters: true }, orderBy: { opportunityScore: "desc" }, take: 30, select: { address: true, chain: true, symbol: true } });
  const w = s.weights;
  const weights = Object.entries(w) as [string, number][];
  const total = weights.reduce((a, [, v]) => a + v, 0) || 1;
  return (
    <div className="space-y-4">
      <PageHeader title="Strategies" subtitle="Your active strategy: scanner filters, opportunity-score weights and the profit-taking ladder." right={<Link href="/settings/trading" className="rounded-md bg-accent px-3 py-2 text-sm text-white">Edit strategy</Link>} />
      <div className="grid gap-4 lg:grid-cols-3">
        <Card>
          <CardHeader title="Scanner filters" />
          <CardBody className="space-y-1.5 text-xs">
            {([
              ["Market cap", `${compactUsd(s.filters.minMarketCapUsd)} – ${compactUsd(s.filters.maxMarketCapUsd)}`],
              ["Min liquidity", compactUsd(s.filters.minLiquidityUsd)], ["Min 24h volume", compactUsd(s.filters.minVolume24hUsd)], ["Min holders", String(s.filters.minHolders)],
              ["Max token age", s.filters.maxTokenAgeHours === null ? "unlimited" : `${s.filters.maxTokenAgeHours}h`], ["Min tx (1h)", String(s.filters.minTxCount1h)],
              ["Max price impact", `${s.filters.maxPriceImpactPct}% @ $${s.filters.priceImpactProbeUsd}`], ["DEXes", s.filters.dexes.length ? s.filters.dexes.join(", ") : "all"], ["Chains", s.filters.chains.join(", ")],
            ] as [string, string][]).map(([k, v]) => <div key={k} className="flex justify-between"><span className="text-muted">{k}</span><span className="num">{v}</span></div>)}
          </CardBody>
        </Card>
        <Card>
          <CardHeader title="Score weights" sub="Analytical ranking, not a profit probability" />
          <CardBody className="space-y-2">
            {weights.map(([k, v]) => (
              <div key={k} className="text-xs">
                <div className="flex justify-between"><span>{k}</span><span className="num text-muted">{((v / total) * 100).toFixed(0)}%</span></div>
                <div className="mt-0.5 h-1 rounded bg-surface2"><div className="h-1 rounded bg-accent" style={{ width: `${(v / total) * 100}%` }} /></div>
              </div>
            ))}
          </CardBody>
        </Card>
        <Card>
          <CardHeader title="Profit ladder" right={<Badge>{s.targetsMode}</Badge>} />
          <CardBody className="space-y-2 text-xs">
            {s.targets.map((t, i) => (
              <div key={t.level} className="flex justify-between"><span>Target {t.level}: +{t.gainPct}%</span><span className="num text-muted">sell {i === s.targets.length - 1 || t.sellPct >= 100 ? "remaining" : `${t.sellPct}% of initial`}</span></div>
            ))}
            <p className="pt-2 text-muted">There is no stop-loss step. Losing positions are held unless emergency protection triggers.</p>
          </CardBody>
        </Card>
      </div>
      <BacktestPanel tokens={btTokens} />
    </div>
  );
}