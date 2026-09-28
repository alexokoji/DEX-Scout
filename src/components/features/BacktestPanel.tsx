"use client";

import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { Input, Label, Select } from "@/components/ui/form";
import { usd } from "@/lib/format";

interface Result {
  strategy: string;
  bars: number;
  trades: { entryTime: number; exitTime: number | null; investedUsd: number; realizedPnlUsd: number; closed: boolean; holdBars: number }[];
  totalPnlUsd: number;
  winRate: number;
  avgHoldBars: number;
  maxDrawdownPct: number;
  capitalUtilization: number;
  openAtEnd: number;
  disclaimer: string;
}

export function BacktestPanel({ tokens }: { tokens: { address: string; chain: string; symbol: string }[] }) {
  const [address, setAddress] = useState(tokens[0] ? `${tokens[0].chain}:${tokens[0].address}` : "");
  const [tf, setTf] = useState("15m");
  const [pos, setPos] = useState("10");
  const [res, setRes] = useState<Result | null>(null);
  const [busy, setBusy] = useState(false);

  async function run() {
    setBusy(true);
    try {
      const r = await fetch("/api/backtest", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ chain: address.split(":")[0], tokenAddress: address.split(":")[1], timeframe: tf, positionUsd: Number(pos) }) });
      const j = await r.json();
      if (!r.ok) toast.error(j.error ?? "Backtest failed");
      else setRes(j);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <CardHeader title="Backtest" sub="Replays recent candles through an EMA-cross entry and YOUR profit ladder (no stop loss)." />
      <CardBody className="space-y-4">
        <div className="grid gap-3 sm:grid-cols-4">
          <div className="sm:col-span-2">
            <Label>Token</Label>
            <Select value={address} onChange={(e) => setAddress(e.target.value)}>
              {tokens.map((t) => <option key={`${t.chain}:${t.address}`} value={`${t.chain}:${t.address}`}>{t.symbol} · {t.chain}</option>)}
            </Select>
          </div>
          <div>
            <Label>Timeframe</Label>
            <Select value={tf} onChange={(e) => setTf(e.target.value)}>
              {["1m", "5m", "15m", "30m", "1h", "4h"].map((x) => <option key={x}>{x}</option>)}
            </Select>
          </div>
          <div>
            <Label hint="USD">Position</Label>
            <Input type="number" min="1" value={pos} onChange={(e) => setPos(e.target.value)} />
          </div>
        </div>
        <Button onClick={run} disabled={busy || !address}>{busy ? "Running…" : "Run backtest"}</Button>
        {res && (
          <div className="space-y-3">
            <div className="grid grid-cols-2 gap-3 text-xs sm:grid-cols-6">
              {([
                ["Trades", String(res.trades.length)], ["Total P/L", usd(res.totalPnlUsd)], ["Win rate", `${(res.winRate * 100).toFixed(0)}%`],
                ["Avg hold", `${res.avgHoldBars.toFixed(0)} bars`], ["Max drawdown", `${res.maxDrawdownPct.toFixed(1)}%`], ["Capital used", `${(res.capitalUtilization * 100).toFixed(0)}%`],
              ] as [string, string][]).map(([k, v]) => (
                <div key={k}><div className="text-muted">{k}</div><div className="num text-sm">{v}</div></div>
              ))}
            </div>
            {res.openAtEnd > 0 && <p className="text-xs text-warn">{res.openAtEnd} position(s) still open at the end (marked to market; no stop loss).</p>}
            <p className="text-[11px] text-muted">{res.disclaimer}</p>
          </div>
        )}
      </CardBody>
    </Card>
  );
}