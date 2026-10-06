import Link from "next/link";
import { Change, RiskBadge, ScoreBar, SignalBadge, TrustBadge } from "@/components/ui/badges";
import { EmptyState } from "@/components/ui/card";
import { chainMeta } from "@/core/chains";
import { age, compactUsd, int, price } from "@/lib/format";
import { PriceAge } from "./PriceAge";

export interface TokenRow {
  id: string;
  address: string;
  chain: string;
  symbol: string;
  name: string;
  dex: string;
  dataSource: string;
  priceUsd: number;
  lastScannedAt?: Date | string | null;
  marketCapUsd: number;
  liquidityUsd: number;
  volume24hUsd: number;
  change5m: number;
  change1h: number;
  buySellRatio: number;
  holders: number;
  holderGrowth1h: number;
  poolCreatedAt: Date | null;
  opportunityScore: number;
  riskLevel: string;
  trustTier?: string | null;
  stage: string;
  passedFilters: boolean;
  signals: { id: string; type: string; score: number }[];
}

const TH = "px-3 py-2 text-left text-[11px] font-semibold uppercase tracking-wider text-muted whitespace-nowrap";

export function TokenTable({ rows, showStage = false }: { rows: TokenRow[]; showStage?: boolean }) {
  if (!rows.length) {
    return <EmptyState title="No tokens match" hint="Adjust or reset the filters. The scanner keeps running in the background; new tokens appear automatically." />;
  }
  return (
    <>
      <div className="hidden overflow-x-auto md:block">
        <table className="w-full min-w-[1060px] text-sm">
          <thead className="border-b border-border">
            <tr>
              <th className={TH}>Token</th>
              <th className={TH}>Price</th>
              <th className={TH}>Mkt cap</th>
              <th className={TH}>Liquidity</th>
              <th className={TH}>24h vol</th>
              <th className={TH}>5m</th>
              <th className={TH}>1h</th>
              <th className={TH}>B/S</th>
              <th className={TH}>Holders</th>
              <th className={TH}>Age</th>
              <th className={TH}>Score</th>
              <th className={TH}>Trust</th>
              <th className={TH}>Risk</th>
              <th className={TH}>{showStage ? "Stage" : "Signal"}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((t) => (
              <tr key={t.id} className="border-b border-border/60 transition-colors hover:bg-surface2">
                <td className="px-3 py-2">
                  <Link href={`/tokens/${t.address}?chain=${t.chain}`} className="flex flex-col">
                    <span className="font-medium">{t.symbol}</span>
                    <span className="text-[11px] text-muted">{t.name} · {chainMeta(t.chain).name} · {t.dex}</span>
                  </Link>
                </td>
                <td className="num px-3 py-2">{price(t.priceUsd)}<div><PriceAge at={t.lastScannedAt} label="" /></div></td>
                <td className="num px-3 py-2">{compactUsd(t.marketCapUsd)}</td>
                <td className="num px-3 py-2">{compactUsd(t.liquidityUsd)}</td>
                <td className="num px-3 py-2">{compactUsd(t.volume24hUsd)}</td>
                <td className="px-3 py-2"><Change value={t.change5m} /></td>
                <td className="px-3 py-2"><Change value={t.change1h} /></td>
                <td className="num px-3 py-2">{t.buySellRatio.toFixed(2)}</td>
                <td className="num px-3 py-2">{int(t.holders)} <span className={t.holderGrowth1h > 0 ? "text-up" : "text-muted"}>{t.holderGrowth1h ? `${t.holderGrowth1h > 0 ? "+" : ""}${t.holderGrowth1h.toFixed(1)}%` : ""}</span></td>
                <td className="num px-3 py-2">{age(t.poolCreatedAt)}</td>
                <td className="px-3 py-2"><ScoreBar score={t.opportunityScore} /></td>
                <td className="px-3 py-2"><TrustBadge tier={t.trustTier} /></td>
                <td className="px-3 py-2">{t.passedFilters ? <RiskBadge level={t.riskLevel} /> : <span className="text-muted">—</span>}</td>
                <td className="px-3 py-2">{showStage ? <span className="text-[11px] text-muted">{t.stage.replace("_", " ")}</span> : <SignalBadge type={t.signals[0]?.type} />}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="divide-y divide-border md:hidden">
        {rows.map((t) => (
          <Link key={t.id} href={`/tokens/${t.address}?chain=${t.chain}`} className="block p-3 hover:bg-surface2">
            <div className="flex items-center justify-between">
              <div className="font-medium">{t.symbol} <span className="text-[11px] text-muted">{chainMeta(t.chain).name} · {t.dex}</span></div>
              <SignalBadge type={t.signals[0]?.type} />
            </div>
            <div className="mt-1 grid grid-cols-3 gap-2 text-xs">
              <div><div className="text-muted">Price</div><div className="num">{price(t.priceUsd)}</div><PriceAge at={t.lastScannedAt} label="" /></div>
              <div><div className="text-muted">Mcap</div><div className="num">{compactUsd(t.marketCapUsd)}</div></div>
              <div><div className="text-muted">Liq</div><div className="num">{compactUsd(t.liquidityUsd)}</div></div>
              <div><div className="text-muted">5m</div><Change value={t.change5m} /></div>
              <div><div className="text-muted">1h</div><Change value={t.change1h} /></div>
              <div><div className="text-muted">Score</div><ScoreBar score={t.opportunityScore} /></div>
            </div>
            <div className="mt-2 flex flex-wrap gap-1.5"><TrustBadge tier={t.trustTier} />{t.passedFilters && <RiskBadge level={t.riskLevel} />}</div>
          </Link>
        ))}
      </div>
    </>
  );
}
