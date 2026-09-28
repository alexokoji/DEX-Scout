"use client";

import { CandlestickSeries, ColorType, createChart, HistogramSeries, LineSeries, type UTCTimestamp } from "lightweight-charts";
import { useEffect, useRef, useState } from "react";
import { Badge } from "@/components/ui/badges";
import { Card, CardHeader, Skeleton } from "@/components/ui/card";
import { cn } from "@/lib/utils";

const TFS = ["1m", "5m", "15m", "30m", "1h", "4h"] as const;

interface CandleResp {
  candles: { time: number; open: number; high: number; low: number; close: number; volume: number; buys: number; sells: number }[];
  overlays: { ema9: { time: number; value: number }[]; ema21: { time: number; value: number }[]; vwap: { time: number; value: number }[] };
  indicators: { rsi14: number | null; macd: { macd: number; signal: number; histogram: number } | null; sma20: number | null; sma50: number | null; ema9: number | null; ema21: number | null; vwap: number | null; volumeSpike: number | null; atr14: number | null };
  market: { trend: string; support: number | null; resistance: number | null; breakout: boolean; pullback: boolean };
  history: { time: number; holders: number; liquidityUsd: number }[];
  source: string;
}

const theme = {
  layout: { background: { type: ColorType.Solid, color: "transparent" }, textColor: "#7f8a9d" },
  grid: { vertLines: { color: "#1a2030" }, horzLines: { color: "#1a2030" } },
  rightPriceScale: { borderColor: "#232a38" },
  timeScale: { borderColor: "#232a38", timeVisible: true, secondsVisible: false },
};

function MiniLine({ data, color, height = 120 }: { data: { time: number; value: number }[]; color: string; height?: number }) {
  const ref = useRef<HTMLDivElement>(null);
  const enough = data.length >= 2;
  useEffect(() => {
    if (!ref.current || !enough) return;
    const chart = createChart(ref.current, { ...theme, height, autoSize: true });
    const s = chart.addSeries(LineSeries, { color, lineWidth: 2 });
    // strictly ascending unique timestamps are required by the chart
    const seen = new Set<number>();
    s.setData(data.filter((d) => (seen.has(d.time) ? false : (seen.add(d.time), true))).map((d) => ({ time: d.time as UTCTimestamp, value: d.value })));
    chart.timeScale().fitContent();
    return () => chart.remove();
  }, [data, color, height, enough]);
  if (!enough) return <div className="flex h-[120px] items-center justify-center text-xs text-muted">Collecting history… (needs a few scans)</div>;
  return <div ref={ref} style={{ height }} />;
}

export function TokenChart({ address, chain }: { address: string; chain: string }) {
  const [tf, setTf] = useState<(typeof TFS)[number]>("5m");
  const [data, setData] = useState<CandleResp | null>(null);
  const [error, setError] = useState<string | null>(null);
  const el = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const r = await fetch(`/api/tokens/${address}/candles?tf=${tf}&limit=300&chain=${chain}`);
        if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error ?? "Failed to load chart");
        const j = (await r.json()) as CandleResp;
        if (!cancelled) {
          setData(j);
          setError(null);
        }
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : "Failed to load chart");
      }
    };
    void load();
    const id = setInterval(() => document.visibilityState === "visible" && void load(), 20_000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [address, chain, tf]);

  useEffect(() => {
    if (!el.current || !data?.candles.length) return;
    const chart = createChart(el.current, { ...theme, height: 380, autoSize: true });
    const c = chart.addSeries(CandlestickSeries, { upColor: "#26d07c", downColor: "#f5475b", borderVisible: false, wickUpColor: "#26d07c", wickDownColor: "#f5475b", priceFormat: { type: "price", precision: 8, minMove: 0.00000001 } });
    c.setData(data.candles.map((k) => ({ time: k.time as UTCTimestamp, open: k.open, high: k.high, low: k.low, close: k.close })));
    const line = (arr: { time: number; value: number }[], color: string) => {
      const s = chart.addSeries(LineSeries, { color, lineWidth: 1, priceLineVisible: false, lastValueVisible: false });
      s.setData(arr.map((p) => ({ time: p.time as UTCTimestamp, value: p.value })));
    };
    line(data.overlays.ema9, "#f5b942");
    line(data.overlays.ema21, "#3b82f6");
    line(data.overlays.vwap, "#a78bfa");
    if (data.market.support) c.createPriceLine({ price: data.market.support, color: "#26d07c88", lineStyle: 2, title: "support" });
    if (data.market.resistance) c.createPriceLine({ price: data.market.resistance, color: "#f5475b88", lineStyle: 2, title: "resist." });
    const v = chart.addSeries(HistogramSeries, { priceFormat: { type: "volume" }, priceScaleId: "vol" });
    chart.priceScale("vol").applyOptions({ scaleMargins: { top: 0.8, bottom: 0 } });
    v.setData(data.candles.map((k) => ({ time: k.time as UTCTimestamp, value: k.volume, color: k.close >= k.open ? "#26d07c55" : "#f5475b55" })));
    chart.timeScale().fitContent();
    return () => chart.remove();
  }, [data]);

  const ind = data?.indicators;
  const fmt = (n: number | null | undefined, d = 2) => (n === null || n === undefined ? "—" : n.toFixed(d));
  const px = (n: number | null | undefined) => (n === null || n === undefined ? "—" : n.toPrecision(5));

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader
          title="Price chart"
          sub={<span className="flex items-center gap-2"><span className="text-[#f5b942]">EMA9</span><span className="text-accent">EMA21</span><span className="text-[#a78bfa]">VWAP</span>{data?.source === "MOCK" && <Badge>Mock data</Badge>}</span>}
          right={
            <div className="flex gap-1">
              {TFS.map((t) => (
                <button key={t} onClick={() => setTf(t)} className={cn("rounded px-2 py-1 text-xs", t === tf ? "bg-accent text-white" : "text-muted hover:bg-surface2")}>{t}</button>
              ))}
            </div>
          }
        />
        <div className="p-2">
          {error ? <div className="p-6 text-sm text-down">{error}</div> : !data ? <Skeleton className="h-[380px]" /> : <div ref={el} className="h-[380px]" />}
        </div>
      </Card>

      <Card>
        <CardHeader title={`Technical indicators · ${tf}`} sub={data ? `Trend ${data.market.trend}${data.market.breakout ? " · breakout" : ""}${data.market.pullback ? " · pullback" : ""}` : undefined} />
        <div className="grid grid-cols-2 gap-px bg-border sm:grid-cols-4 lg:grid-cols-8">
          {[
            ["RSI 14", fmt(ind?.rsi14, 1)],
            ["MACD hist", ind?.macd ? ind.macd.histogram.toExponential(2) : "—"],
            ["EMA 9", px(ind?.ema9)],
            ["EMA 21", px(ind?.ema21)],
            ["SMA 20", px(ind?.sma20)],
            ["VWAP", px(ind?.vwap)],
            ["Vol spike", ind?.volumeSpike ? `${ind.volumeSpike.toFixed(2)}x` : "—"],
            ["ATR 14", px(ind?.atr14)],
          ].map(([k, v]) => (
            <div key={k} className="bg-surface p-3">
              <div className="text-[11px] uppercase tracking-wider text-muted">{k}</div>
              <div className="num mt-0.5 truncate text-sm">{v}</div>
            </div>
          ))}
        </div>
      </Card>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader title="Liquidity (USD)" sub="From scanner snapshots" />
          <div className="p-2"><MiniLine data={(data?.history ?? []).map((h) => ({ time: h.time, value: h.liquidityUsd }))} color="#3b82f6" /></div>
        </Card>
        <Card>
          <CardHeader title="Holder growth" sub="From scanner snapshots" />
          <div className="p-2"><MiniLine data={(data?.history ?? []).map((h) => ({ time: h.time, value: h.holders }))} color="#26d07c" /></div>
        </Card>
      </div>
    </div>
  );
}