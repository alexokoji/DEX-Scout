"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { Input, Label, Select, Switch } from "@/components/ui/form";
import { CHAIN_IDS, CHAINS, hasFreeSwapRoute } from "@/core/chains";
import { DEFAULT_TARGETS_MULTI, DEFAULT_TARGETS_SINGLE } from "@/core/config";
import type { UserSettings } from "@/services/settings";

type S = Omit<UserSettings, "id" | "userId">;

function Num({ label, hint, value, onChange, step = "any", min = 0, err }: { label: string; hint?: string; value: number | null; onChange: (v: number) => void; step?: string; min?: number; err?: string }) {
  return (
    <div>
      <Label hint={hint}>{label}</Label>
      <Input type="number" step={step} min={min} value={value ?? ""} onChange={(e) => onChange(Number(e.target.value))} />
      {err && <p className="mt-0.5 text-[11px] text-down">{err}</p>}
    </div>
  );
}

export function TradingSettingsForm({ initial, liveEnabled }: { initial: S; liveEnabled: boolean }) {
  const router = useRouter();
  const [s, setS] = useState<S>(initial);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const set = <K extends keyof S>(k: K, v: S[K]) => setS((p) => ({ ...p, [k]: v }));
  const setF = <K extends keyof S["filters"]>(k: K, v: S["filters"][K]) => setS((p) => ({ ...p, filters: { ...p.filters, [k]: v } }));

  async function save() {
    setBusy(true);
    setErrors({});
    try {
      const r = await fetch("/api/settings", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(s) });
      const j = await r.json();
      if (!r.ok) {
        if (j.issues) setErrors(Object.fromEntries(j.issues.map((i: { path: string; message: string }) => [i.path, i.message])));
        toast.error(j.issues?.[0]?.message ?? j.error ?? "Could not save");
      } else {
        toast.success("Trading settings saved");
        router.refresh();
      }
    } finally {
      setBusy(false);
    }
  }

  const setTargets = (t: S["targets"]) => set("targets", t);

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader title="Mode" sub="MANUAL: signals only. LIVE: real swaps that your wallet must approve." />
        <CardBody className="grid gap-4 md:grid-cols-3">
          <div>
            <Label>Bot environment</Label>
            <Select value={s.environment} onChange={(e) => set("environment", e.target.value as S["environment"])}>
              <option value="MANUAL">Manual (bot never trades)</option>
              <option value="LIVE" disabled={!liveEnabled}>Live{liveEnabled ? "" : " (disabled by server config)"}</option>
            </Select>
          </div>
          <div className="flex items-end gap-3">
            <Switch checked={s.autoTradingEnabled} onCheckedChange={(v) => set("autoTradingEnabled", v)} />
            <span className="text-sm">Auto trading {s.autoTradingEnabled ? "ON" : "OFF"}</span>
          </div>
          <p className="text-[11px] text-muted md:col-span-3">Auto trading also requires the bot to be started on the Bot page. LIVE is available only when the server sets LIVE_TRADING_ENABLED=true with real (non-mock) providers.</p>
        </CardBody>
      </Card>

      <Card>
        <CardHeader title="Capital & position limits" sub="Enforced server-side on every entry; client values are never trusted." />
        <CardBody className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <Num label="Maximum position size" hint="USD" value={s.maxPositionUsd} onChange={(v) => set("maxPositionUsd", v)} err={errors.maxPositionUsd} />
          <Num label="Minimum position size" hint="USD" value={s.minPositionUsd} onChange={(v) => set("minPositionUsd", v)} err={errors.minPositionUsd} />
          <Num label="Maximum open positions" value={s.maxOpenPositions} step="1" min={1} onChange={(v) => set("maxOpenPositions", v)} err={errors.maxOpenPositions} />
          <Num label="Maximum capital deployed" hint="USD (blank = your wallet balance)" value={s.maxDeployedUsd} onChange={(v) => set("maxDeployedUsd", v || null)} err={errors.maxDeployedUsd} />
          <Num label="Maximum position age" hint="hours (blank = none)" value={s.maxPositionAgeHours} step="1" min={1} onChange={(v) => set("maxPositionAgeHours", v || null)} />
        </CardBody>
      </Card>

      <Card>
        <CardHeader title="Entry rules" />
        <CardBody className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <Num label="Minimum opportunity score" hint="0–100" value={s.minOpportunityScore} onChange={(v) => set("minOpportunityScore", v)} />
          <Num label="Minimum liquidity" hint="USD" value={s.minLiquidityUsd} onChange={(v) => set("minLiquidityUsd", v)} />
          <Num label="Minimum 24h volume" hint="USD" value={s.minVolume24hUsd} onChange={(v) => set("minVolume24hUsd", v)} />
          <Num label="Maximum price impact" hint="%" value={s.maxPriceImpactPct} onChange={(v) => set("maxPriceImpactPct", v)} />
          <Num label="Maximum slippage" hint="bps (100 = 1%)" value={s.maxSlippageBps} step="1" onChange={(v) => set("maxSlippageBps", v)} />
          <div>
            <Label>Maximum allowed risk</Label>
            <Select value={s.maxAllowedRisk} onChange={(e) => set("maxAllowedRisk", e.target.value as S["maxAllowedRisk"])}>
              <option value="LOWER">Lower only</option>
              <option value="MODERATE">Up to moderate</option>
              <option value="HIGH">Up to high</option>
            </Select>
          </div>
          <div className="sm:col-span-2 lg:col-span-3">
            <Label hint="the bot buys nothing below this">Minimum trust</Label>
            <Select value={s.minTrust} onChange={(e) => set("minTrust", e.target.value as S["minTrust"])}>
              <option value="VERIFIED">Verified: on a curated list and passed every check</option>
              <option value="TRUSTED">Trusted: passed every check, with real liquidity, volume and history (recommended)</option>
              <option value="UNPROVEN">Unproven: no red flags found, but not yet trusted (riskier)</option>
            </Select>
            <p className="mt-1 text-[11px] text-muted">Trusted needs $50K liquidity, $20K daily volume, 24h of history, a real sell test, locked or burned liquidity, and no creator powers or taxes. Risky and dangerous tokens are never bought.</p>
          </div>
        </CardBody>
      </Card>

      <Card>
        <CardHeader title="Scanner filters" sub="Defaults: $250K–$25M market cap, $50K liquidity, $20K 24h volume. All configurable." />
        <CardBody className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <Num label="Min market cap" hint="USD" value={s.filters.minMarketCapUsd} onChange={(v) => setF("minMarketCapUsd", v)} err={errors["filters.minMarketCapUsd"]} />
          <Num label="Max market cap" hint="USD" value={s.filters.maxMarketCapUsd} onChange={(v) => setF("maxMarketCapUsd", v)} />
          <Num label="Min liquidity" hint="USD" value={s.filters.minLiquidityUsd} onChange={(v) => setF("minLiquidityUsd", v)} />
          <Num label="Min 24h volume" hint="USD" value={s.filters.minVolume24hUsd} onChange={(v) => setF("minVolume24hUsd", v)} />
          <Num label="Min holders" value={s.filters.minHolders} step="1" onChange={(v) => setF("minHolders", v)} />
          <Num label="Max token age" hint="hours" value={s.filters.maxTokenAgeHours} step="1" onChange={(v) => setF("maxTokenAgeHours", v || null)} />
          <Num label="Min transactions (1h)" value={s.filters.minTxCount1h} step="1" onChange={(v) => setF("minTxCount1h", v)} />
          <Num label="Max price impact" hint="% at probe size" value={s.filters.maxPriceImpactPct} onChange={(v) => setF("maxPriceImpactPct", v)} />
          <div className="sm:col-span-full">
            <Label hint="scanning rotates through them, so adding chains never slows a scan">Chains to scan</Label>
            <div className="flex flex-wrap gap-3 text-xs">
              {CHAIN_IDS.map((c) => (
                <label key={c} className="flex items-center gap-1.5">
                  <input type="checkbox" checked={s.filters.chains.includes(c)} onChange={(e) => setF("chains", e.target.checked ? [...s.filters.chains, c] : s.filters.chains.filter((x) => x !== c))} />
                  {CHAINS[c].name}
                  {!hasFreeSwapRoute(c) && <span className="text-[10px] text-muted" title="Tokens here are scanned and scored, but swapping needs a (free-tier) 0x API key — see Integrations.">· scan only</span>}
                </label>
              ))}
            </div>
          </div>
          <div className="sm:col-span-2">
            <Label hint="comma separated, blank = all">Supported DEXes</Label>
            <Input value={s.filters.dexes.join(", ")} onChange={(e) => setF("dexes", e.target.value.split(",").map((x) => x.trim()).filter(Boolean))} placeholder="Raydium, Orca, Meteora" />
          </div>
        </CardBody>
      </Card>

      <Card>
        <CardHeader
          title="Default profit targets"
          sub="What a new position starts with. Each position can then be given its own targets (Positions → Edit targets, or in the trade panel when you buy). Each target sells a share of the position; the last sells whatever remains."
          right={
            <div className="flex gap-2">
              <Select className="w-32" value={s.targetsMode} onChange={(e) => { const m = e.target.value as S["targetsMode"]; set("targetsMode", m); setTargets(m === "SINGLE" ? DEFAULT_TARGETS_SINGLE : DEFAULT_TARGETS_MULTI); }}>
                <option value="SINGLE">Single</option>
                <option value="MULTI">Multi</option>
              </Select>
            </div>
          }
        />
        <CardBody className="space-y-2">
          <div className="mb-1">
            <Label hint="for buys the bot makes, and for yours if you don't set targets">New positions get</Label>
            <Select value={s.targetsSource} onChange={(e) => set("targetsSource", e.target.value as S["targetsSource"])}>
              <option value="FIXED">The ladder below, the same for every position</option>
              <option value="PROJECTED">Targets drawn from each token&apos;s own price history (different for each position), falling back to the ladder below when there isn&apos;t enough history</option>
            </Select>
          </div>
          {s.targets.map((t, i) => (
            <div key={i} className="grid grid-cols-[auto_1fr_1fr_auto] items-end gap-3">
              <div className="pb-2 text-xs text-muted">T{t.level}</div>
              <Num label="Gain" hint="%" value={t.gainPct} onChange={(v) => setTargets(s.targets.map((x, j) => (j === i ? { ...x, gainPct: v } : x)))} />
              <Num label="Sell" hint="% of initial" value={t.sellPct} onChange={(v) => setTargets(s.targets.map((x, j) => (j === i ? { ...x, sellPct: v } : x)))} />
              <Button type="button" variant="ghost" size="sm" disabled={s.targets.length <= 1} onClick={() => setTargets(s.targets.filter((_, j) => j !== i).map((x, j) => ({ ...x, level: j + 1 })))}>Remove</Button>
            </div>
          ))}
          {errors.targets && <p className="text-[11px] text-down">{errors.targets}</p>}
          <Button type="button" variant="outline" size="sm" disabled={s.targets.length >= 8} onClick={() => setTargets([...s.targets, { level: s.targets.length + 1, gainPct: (s.targets[s.targets.length - 1]?.gainPct ?? 0) + 10, sellPct: 25 }])}>Add target</Button>
        </CardBody>
      </Card>

      <Card className="border-accent/30">
        <CardHeader title="Loss handling & emergency protection" />
        <CardBody className="space-y-4">
          <p className="text-xs leading-relaxed text-muted">
            There is <span className="font-semibold text-foreground">no stop loss</span>. A position that is down 5%, 10% or 20% stays open until a profit target is reached. Emergency protection is separate:
            it only reacts to catastrophic conditions — token untradeable, pool disappears, sell simulation fails, severe liquidity collapse, critical security condition, or extreme execution risk.
          </p>
          <div className="grid gap-4 sm:grid-cols-3">
            <div className="flex items-center gap-3"><Switch checked={s.emergencyEnabled} onCheckedChange={(v) => set("emergencyEnabled", v)} /><span className="text-sm">Emergency detection</span></div>
            <div className="flex items-center gap-3"><Switch checked={s.emergencyAutoExit} disabled={!s.emergencyEnabled} onCheckedChange={(v) => set("emergencyAutoExit", v)} /><span className="text-sm">Allow automatic emergency exit</span></div>
            <Num label="Liquidity collapse threshold" hint="% drop since entry" value={s.emergencyLiquidityDropPct} onChange={(v) => set("emergencyLiquidityDropPct", v)} />
          </div>
        </CardBody>
      </Card>

      <div className="sticky bottom-0 -mx-4 flex justify-end border-t border-border bg-background/90 p-3 backdrop-blur md:-mx-6">
        <Button size="lg" onClick={save} disabled={busy}>{busy ? "Saving…" : "Save settings"}</Button>
      </div>
    </div>
  );
}