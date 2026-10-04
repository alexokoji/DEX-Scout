import { notFound } from "next/navigation";
import { PageHeader } from "@/components/features/PageHeader";
import { TokenChart } from "@/components/features/TokenChart";
import { TradePanel } from "@/components/features/TradePanel";
import { Badge, Change, EnvBadge, RiskBadge, SignalBadge } from "@/components/ui/badges";
import { Card, CardBody, CardHeader, Stat } from "@/components/ui/card";
import type { AiAnalysis } from "@/core/ai/schema";
import { CHAINS } from "@/core/chains";
import { providers } from "@/core/providers/registry";
import type { ChainId, MarketAnalysis, OnChainAnalysis, ScoreComponent } from "@/core/types";
import { requireUser } from "@/lib/auth";
import { liveTradingAllowed } from "@/lib/env";
import { age, compactUsd, int, price, shortAddr, timeAgo } from "@/lib/format";
import { getTokenDetail } from "@/services/queries";
import { getSettings } from "@/services/settings";

export default async function TokenPage({ params, searchParams }: { params: Promise<{ address: string }>; searchParams: Promise<{ chain?: string }> }) {
  const user = await requireUser();
  const { address: rawAddress } = await params;
  const { chain: chainParam } = await searchParams;
  const address = rawAddress.startsWith("0x") ? rawAddress.toLowerCase() : rawAddress;
  const detail = await getTokenDetail(address, chainParam);
  if (!detail) notFound();
  const { token, signal } = detail;
  const settings = await getSettings(user.id);
  const ai = signal?.analysis?.ai as AiAnalysis | null | undefined;
  const market = token.analysis?.market as MarketAnalysis | undefined;
  const onchain = token.analysis?.onchain as OnChainAnalysis | undefined;
  const components = (token.analysis?.components as unknown as ScoreComponent[] | undefined) ?? [];
  const warnings = token.safety?.warnings ?? [];
  const critical = token.safety?.criticalIssues ?? [];
  const explorer = providers().chains[token.chain as ChainId].explorerTokenUrl(token.address);

  return (
    <div className="space-y-4">
      <PageHeader
        title={`${token.symbol} · ${token.name}`}
        subtitle={
          <span className="flex flex-wrap items-center gap-2">
            <a href={explorer} target="_blank" rel="noreferrer" className="num text-accent">{shortAddr(token.address)}</a>
            <span>{token.dex}</span>
            <span>{CHAINS[token.chain as ChainId]?.name ?? token.chain}</span>
            <EnvBadge source={token.dataSource} />
            {token.riskLevel && token.passedFilters && <RiskBadge level={token.riskLevel} />}
            <SignalBadge type={signal?.type} />
          </span>
        }
      />

      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
        <Stat label="Price" value={price(token.priceUsd)} sub={<span className="flex gap-2"><span>5m <Change value={token.change5m} /></span><span>1h <Change value={token.change1h} /></span><span className="text-muted">· updated {timeAgo(token.lastScannedAt)}</span></span>} />
        <Stat label="Market cap" value={compactUsd(token.marketCapUsd)} sub={`FDV ${compactUsd(token.fdvUsd)}`} />
        <Stat label="Liquidity" value={compactUsd(token.liquidityUsd)} sub={`${token.pairCount} pair(s)`} />
        <Stat label="24h volume" value={compactUsd(token.volume24hUsd)} sub={`1h ${compactUsd(token.volume1hUsd)}`} />
        <Stat label="Holders" value={int(token.holders)} sub={`${token.holderGrowth1h >= 0 ? "+" : ""}${token.holderGrowth1h.toFixed(1)}% (1h)`} />
        <Stat label="Token age" value={age(token.poolCreatedAt)} sub={`buy/sell ${token.buySellRatio.toFixed(2)}`} />
      </div>

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_380px]">
        <TokenChart address={token.address} chain={token.chain} />

        <div className="space-y-4">
          {signal && (
            <Card>
              <CardHeader title="Signal" right={<span className="flex items-center gap-2"><SignalBadge type={signal.type} /><span className="num text-sm">{signal.score.toFixed(0)}</span></span>} sub={`Created ${timeAgo(signal.createdAt)} · expires ${timeAgo(signal.expiresAt).replace(" ago", "")}`} />
              <CardBody className="space-y-3 text-sm">
                <div>
                  <div className="text-[11px] uppercase tracking-wider text-muted">Suggested entry zone</div>
                  <div className="num">{price(signal.entryMin)} – {price(signal.entryMax)}</div>
                </div>
                <div className="grid grid-cols-3 gap-2">
                  {[signal.target1, signal.target2, signal.target3].map((t, i) => (
                    <div key={i}>
                      <div className="text-[11px] uppercase tracking-wider text-muted">Target {i + 1}</div>
                      <div className="num">{price(t)}</div>
                      <div className="num text-xs text-up">+{((t / signal.priceUsd - 1) * 100).toFixed(0)}%</div>
                    </div>
                  ))}
                </div>
                <ul className="space-y-0.5 text-xs">
                  {(signal.reasons as string[]).map((r) => <li key={r} className="text-up">+ {r}</li>)}
                  {(signal.warnings as string[]).slice(0, 5).map((w) => <li key={w} className="text-warn">! {w}</li>)}
                </ul>
                <p className="text-[11px] text-muted">Targets are suggestions. Your configured profit ladder ({settings.targets.map((t) => `+${t.gainPct}%`).join(", ")}) is what the bot uses.</p>
              </CardBody>
            </Card>
          )}

          <TradePanel
            chain={token.chain as ChainId}
            address={token.address}
            symbol={token.symbol}
            signalId={signal?.id}
            liveEnabled={liveTradingAllowed()}
            defaults={{ amountUsd: Math.max(settings.minPositionUsd, Math.min(settings.maxPositionUsd, 10)), slippageBps: Math.min(settings.maxSlippageBps, 100), maxPositionUsd: settings.maxPositionUsd }}
          />
        </div>
      </div>

      <div className="grid gap-4 lg:grid-cols-2 xl:grid-cols-3">
        <Card>
          <CardHeader title="Safety analysis" right={token.safety ? <RiskBadge level={token.safety.riskLevel} /> : undefined} sub="Heuristic screen — not a guarantee of safety" />
          <CardBody className="space-y-2 text-xs">
            {token.safety && <div className="num">Risk score {token.safety.riskScore.toFixed(0)} / 100 · checks {token.safety.passed ? "passed" : "not passed"}</div>}
            {critical.map((c) => <div key={c} className="text-down">✕ {c}</div>)}
            {warnings.map((w) => <div key={w} className="text-warn">! {w}</div>)}
            {!critical.length && !warnings.length && <div className="text-muted">No red flags detected by current checks.</div>}
          </CardBody>
        </Card>

        <Card>
          <CardHeader title="On-chain activity" />
          <CardBody className="space-y-1.5 text-xs">
            {onchain ? (
              <>
                <KV k="Whale flow" v={<Badge tone={onchain.whaleBias === "ACCUMULATION" ? "green" : onchain.whaleBias === "DISTRIBUTION" ? "red" : "gray"}>{onchain.whaleBias}</Badge>} />
                <KV k="Net large-wallet flow (1h)" v={compactUsd(onchain.whaleNetFlowUsd)} />
                <KV k="Large buys / sells" v={`${onchain.largeBuys} / ${onchain.largeSells}`} />
                <KV k="Top holder / top 10" v={`${onchain.topHolderPct.toFixed(1)}% / ${onchain.top10HolderPct.toFixed(0)}%`} />
                <KV k="New holders (1h)" v={int(onchain.newHolders1h)} />
                <KV k="Tx acceleration" v={onchain.txAcceleration.toFixed(2)} />
                <KV k="Liquidity added / removed (1h)" v={`${compactUsd(onchain.liquidityAddedUsd)} / ${compactUsd(onchain.liquidityRemovedUsd)}`} />
              </>
            ) : <div className="text-muted">Awaiting analysis…</div>}
          </CardBody>
        </Card>

        <Card>
          <CardHeader title="Opportunity score" right={<span className="num text-lg font-semibold">{token.opportunityScore.toFixed(0)}</span>} sub="Weighted analytical metric — not a probability of profit" />
          <CardBody className="space-y-1.5">
            {components.map((c) => (
              <div key={c.key} className="text-xs">
                <div className="flex justify-between"><span>{c.label}</span><span className="num text-muted">{(c.value * 100).toFixed(0)} · w{c.weight}</span></div>
                <div className="mt-0.5 h-1 rounded bg-surface2"><div className="h-1 rounded bg-accent" style={{ width: `${c.value * 100}%` }} /></div>
              </div>
            ))}
          </CardBody>
        </Card>

        {market && (
          <Card>
            <CardHeader title="Market structure" />
            <CardBody className="space-y-1.5 text-xs">
              <KV k="Trend" v={market.trend} />
              <KV k="Price momentum" v={market.priceMomentum.toFixed(2)} />
              <KV k="Volume momentum" v={market.volumeMomentum.toFixed(2)} />
              <KV k="Liquidity trend (1h)" v={`${market.liquidityTrend.toFixed(1)}%`} />
              <KV k="Buy/sell ratio" v={market.buySellRatio.toFixed(2)} />
              <KV k="Support / resistance" v={`${market.support ? price(market.support) : "—"} / ${market.resistance ? price(market.resistance) : "—"}`} />
              <KV k="Breakout / pullback" v={`${market.breakout ? "yes" : "no"} / ${market.pullback ? "yes" : "no"}`} />
              {market.overextended && <div className="text-warn">! Price looks overextended</div>}
            </CardBody>
          </Card>
        )}

        <Card className="xl:col-span-2">
          <CardHeader title="AI market analysis" right={<Badge tone="gray">{signal?.analysis?.aiProvider ?? "n/a"}</Badge>} sub="Interpretation of the engines' structured data. Display-only: it can never trigger or approve a trade." />
          <CardBody className="space-y-3 text-sm">
            {ai ? (
              <>
                <p>{ai.whatIsHappening}</p>
                <p className="text-muted">{ai.whyInteresting}</p>
                <p className="text-muted">{ai.recentChanges}</p>
                <p className="text-xs"><span className="font-semibold">Strategy fit:</span> {ai.strategyFit.matches ? "matches" : "does not fully match"} — {ai.strategyFit.explanation}</p>
                <div className="grid gap-3 sm:grid-cols-2">
                  <div>
                    <div className="mb-1 text-[11px] font-semibold uppercase tracking-wider text-muted">Primary risks</div>
                    <ul className="space-y-0.5 text-xs">{ai.primaryRisks.map((r) => <li key={r}>• {r}</li>)}</ul>
                  </div>
                  <div>
                    <div className="mb-1 text-[11px] font-semibold uppercase tracking-wider text-muted">Would invalidate the setup</div>
                    <ul className="space-y-0.5 text-xs">{ai.invalidation.map((r) => <li key={r}>• {r}</li>)}</ul>
                  </div>
                </div>
              </>
            ) : <div className="text-xs text-muted">Analysis is generated when a BUY/WATCH signal exists for this token.</div>}
          </CardBody>
        </Card>
      </div>
    </div>
  );
}

function KV({ k, v }: { k: string; v: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="text-muted">{k}</span>
      <span className="num">{v}</span>
    </div>
  );
}