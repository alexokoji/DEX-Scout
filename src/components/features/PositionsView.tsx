import Link from "next/link";
import { EnvBadge, HealthBadge, PnL, SignalBadge, Badge } from "@/components/ui/badges";
import { EmptyState } from "@/components/ui/card";
import { age, price, tokens, usd, usdPnl } from "@/lib/format";
import { ClosePositionButton } from "./ClosePositionButton";
import { AutoSellPanel, type AutoSellView } from "./AutoSellPanel";
import { LivePositionPnL, LivePositionPrice } from "./LivePrice";
import { PositionTargets } from "./PositionTargets";
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
  entryMarketPriceUsd?: number;
  costBasisUsd: number;
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
  autoSells?: AutoSellView[];
  /** what the wallet itself did over this position's transactions (see core/trading/walletResult.ts); null when not all of them were read from the chain */
  wallet?: { changeUsd: number; feesUsd: number; depositHeldUsd: number; swapNetUsd: number } | null;
  metrics: { currentValueUsd: number; pricePnlUsd: number; pricePnlPct: number; unrealizedPnlUsd: number; pnlPct: number; nextTargetLevel: number | null; nextTargetGainPct: number | null; targetProgress: number };
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
                {closed ? (
                  <PnL value={p.realizedPnlUsd} pct={p.investedUsd > 0 ? (p.realizedPnlUsd / p.investedUsd) * 100 : undefined} className="text-base font-semibold" />
                ) : (
                  <LivePositionPnL chain={p.token.chain} address={p.token.address} fallbackUsd={p.currentPriceUsd} amount={p.amount} entryPriceUsd={p.entryPriceUsd} className="text-base font-semibold" />
                )}
                {actions && !closed && <ClosePositionButton id={p.id} symbol={p.token.symbol} chain={p.token.chain} />}
              </div>
            </div>

            <div className="mt-3 grid grid-cols-2 gap-3 text-xs sm:grid-cols-4 lg:grid-cols-7">
              <div>
                <div className="text-muted">Entry (price paid)</div>
                <div className="num">{price(p.entryPriceUsd)}</div>
                {p.entryMarketPriceUsd ? <div className="text-[10px] text-muted">market then {price(p.entryMarketPriceUsd)}</div> : null}
              </div>
              {closed ? <Cell k="Current" v={price(p.currentPriceUsd)} /> : <LivePositionPrice chain={p.token.chain} address={p.token.address} fallbackUsd={p.currentPriceUsd} entryPriceUsd={p.entryPriceUsd} />}
              <Cell k="Amount" v={tokens(p.amount)} />
              <Cell k="Invested" v={usd(p.investedUsd, p.investedUsd < 1 ? 4 : 2)} />
              <Cell k="Value" v={usd(p.metrics.currentValueUsd, p.metrics.currentValueUsd < 1 ? 4 : 2)} />
              <Cell k="Realized" v={usdPnl(p.realizedPnlUsd)} />
              <div>
                <div className="text-muted">{p.metrics.nextTargetLevel ? `Target ${p.metrics.nextTargetLevel} (+${p.metrics.nextTargetGainPct}%)` : "All targets hit"}</div>
                <div className="mt-1.5 h-1.5 rounded bg-surface2"><div className="h-1.5 rounded bg-up" style={{ width: `${p.metrics.targetProgress * 100}%` }} /></div>
                {!closed && actions && p.environment === "LIVE" && p.targets.length > 0 && (
                  <div className="mt-1"><PositionTargets positionId={p.id} chain={p.token.chain} address={p.token.address} symbol={p.token.symbol} targets={p.targets} armed={(p.autoSells ?? []).some((o) => o.status === "ACTIVE")} /></div>
                )}
              </div>
            </div>

            {p.environment === "LIVE" && p.wallet && (closed || p.wallet.depositHeldUsd > 0) && <WalletLine closed={closed} w={p.wallet} />}

            {!closed && actions && p.environment === "LIVE" && <AutoSellPanel positionId={p.id} chain={p.token.chain} orders={p.autoSells ?? []} />}

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

/** The wallet's own result next to the price-based profit, so the two can be reconciled with what the wallet shows. */
function WalletLine({ closed, w }: { closed: boolean; w: NonNullable<PV["wallet"]> }) {
  return (
    <div className="mt-3 rounded-md border border-border bg-surface2 px-3 py-2 text-[11px] leading-relaxed text-muted">
      {closed ? (
        <>
          <span className="font-medium text-foreground">Your wallet: {usdPnl(w.changeUsd)}</span> in total. That is the swaps {usdPnl(w.swapNetUsd)}, network fees {usdPnl(-w.feesUsd)}
          {w.depositHeldUsd > 0 ? `, and ${usd(w.depositHeldUsd, 4)} still held as a token-account deposit (not lost: it comes back when the empty account is closed)` : ""}. The profit above is the price change only, so it leaves out the fees and the deposit.
        </>
      ) : (
        <>
          <span className="font-medium text-foreground">Token-account deposit held: {usd(w.depositHeldUsd, 4)}.</span> Not a cost: the chain locked it when this token&apos;s account was opened, and returns it when the empty account is closed after you sell. Your wallet is that much lower until then.
        </>
      )}
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