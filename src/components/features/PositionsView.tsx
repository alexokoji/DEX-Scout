import Link from "next/link";
import { EnvBadge, HealthBadge, PnL, SignalBadge, Badge } from "@/components/ui/badges";
import { EmptyState } from "@/components/ui/card";
import { age, price, tokens, usd } from "@/lib/format";
import { ClosePositionButton } from "./ClosePositionButton";
import { PriceAge } from "./PriceAge";

interface PV {
  id: string;
  token: { symbol: string; address: string; chain: string; dataSource: string };
  environment: string;
  status: string;
  health: string;
  healthNotes: unknown;
  origin: string;
  entryPriceUsd: number;
  currentPriceUsd: number;
  priceAt?: Date | string | null;
  amount: number;
  investedUsd: number;
  realizedPnlUsd: number;
  openedAt: Date;
  updatedAt: Date;
  targetsHit: number;
  signal: { id: string; type: string; score: number } | null;
  targets: { level: number; gainPct: number; sellPct: number }[];
  metrics: { currentValueUsd: number; unrealizedPnlUsd: number; pnlPct: number; nextTargetLevel: number | null; nextTargetGainPct: number | null; targetProgress: number };
}

export function PositionsView({ positions, actions = true }: { positions: PV[]; actions?: boolean }) {
  if (!positions.length) return <EmptyState title="No positions" hint="Open a paper position from any token page, or enable the bot to trade signals automatically." />;
  return (
    <div className="divide-y divide-border">
      {positions.map((p) => {
        const notes = (p.healthNotes ?? {}) as { positives?: string[]; negatives?: string[]; emergencyReasons?: string[] };
        const closed = p.status === "CLOSED";
        return (
          <div key={p.id} className="p-4">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <div className="flex flex-wrap items-center gap-2">
                  <Link href={`/tokens/${p.token.address}?chain=${p.token.chain}`} className="text-base font-semibold hover:text-accent">{p.token.symbol}</Link>
                  <EnvBadge env={p.environment} source={p.token.dataSource} />
                  <Badge tone={p.status === "EMERGENCY" ? "red" : p.status.startsWith("TARGET") || p.status === "PROFITABLE" ? "green" : "gray"}>{p.status.replace("_", " ")}</Badge>
                  {!closed && <HealthBadge health={p.health} />}
                  <Badge>{p.origin}</Badge>
                  {p.signal && <span className="flex items-center gap-1 text-[11px] text-muted">opened by <SignalBadge type={p.signal.type} /> {p.signal.score.toFixed(0)}</span>}
                </div>
                <div className="mt-1 text-[11px] text-muted">opened {age(p.openedAt)} ago · <PriceAge at={p.priceAt ?? null} label="price" /></div>
              </div>
              <div className="flex items-center gap-3">
                <PnL value={p.metrics.unrealizedPnlUsd} pct={p.metrics.pnlPct} className="text-base font-semibold" />
                {actions && !closed && <ClosePositionButton id={p.id} symbol={p.token.symbol} />}
              </div>
            </div>

            <div className="mt-3 grid grid-cols-2 gap-3 text-xs sm:grid-cols-4 lg:grid-cols-7">
              <Cell k="Entry" v={price(p.entryPriceUsd)} />
              <Cell k="Current" v={price(p.currentPriceUsd)} />
              <Cell k="Amount" v={tokens(p.amount)} />
              <Cell k="Invested" v={usd(p.investedUsd)} />
              <Cell k="Value" v={usd(p.metrics.currentValueUsd)} />
              <Cell k="Realized" v={usd(p.realizedPnlUsd)} />
              <div>
                <div className="text-muted">{p.metrics.nextTargetLevel ? `Target ${p.metrics.nextTargetLevel} (+${p.metrics.nextTargetGainPct}%)` : "All targets hit"}</div>
                <div className="mt-1.5 h-1.5 rounded bg-surface2"><div className="h-1.5 rounded bg-up" style={{ width: `${p.metrics.targetProgress * 100}%` }} /></div>
              </div>
            </div>

            {!closed && (notes.positives?.length || notes.negatives?.length || notes.emergencyReasons?.length) ? (
              <div className="mt-3 space-y-0.5 text-[11px]">
                {notes.emergencyReasons?.map((r) => <div key={r} className="text-down">✕ {r}</div>)}
                {notes.negatives?.map((r) => <div key={r} className="text-warn">! {r}</div>)}
                {notes.positives?.map((r) => <div key={r} className="text-up">+ {r}</div>)}
              </div>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

function Cell({ k, v }: { k: string; v: string }) {
  return (
    <div>
      <div className="text-muted">{k}</div>
      <div className="num">{v}</div>
    </div>
  );
}