"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input, Select } from "@/components/ui/form";
import { defaultHorizon, hitRate, LADDER_PROFILES, suggestLadder, type LadderProfile, type Projection } from "@/core/analysis/projection";

export interface TargetRow {
  gainPct: number;
  sellPct: number;
}

const PROFILE_LABEL: Record<LadderProfile, string> = { cautious: "Cautious", typical: "Typical", ambitious: "Ambitious" };
const PROFILE_HINT: Record<LadderProfile, string> = {
  cautious: "targets this token reached in most past windows: likely to fill, smaller",
  typical: "the middle of its range",
  ambitious: "the big moves it makes rarely: large, and often not reached",
};

/**
 * The profit targets for ONE position, set against what this token has actually done. Every target shows how often the token's own
 * history reached that gain, so a target is chosen with its odds in view. The presets pick points on the token's own curve and keep the
 * sell shares from the default ladder. It is a base rate from past behaviour, not a forecast, and says how much history it rests on.
 */
export function TargetsEditor({ value, onChange, projection, defaultLadder, defaultLabel = "My default" }: { value: TargetRow[]; onChange: (v: TargetRow[]) => void; projection: Projection | null | undefined; defaultLadder: TargetRow[]; defaultLabel?: string }) {
  const horizons = projection?.horizons ?? [];
  const [horizonMin, setHorizonMin] = useState<number | null>(null);
  const h = horizons.find((x) => x.horizonMin === horizonMin) ?? (projection ? defaultHorizon(projection) : null);
  const shares = defaultLadder.map((t) => t.sellPct);
  const set = (i: number, patch: Partial<TargetRow>) => onChange(value.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  const apply = (profile: LadderProfile) => {
    if (!h) return;
    const l = suggestLadder(h, shares.length ? shares : [25, 25, 25, 100], profile);
    if (l) onChange(l.map(({ gainPct, sellPct }) => ({ gainPct, sellPct })));
  };

  return (
    <div className="space-y-2 rounded-md border border-border bg-surface2/40 p-3 text-xs">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="font-medium">Profit targets for this position</div>
        {horizons.length > 1 && (
          <Select className="h-7 w-28 text-[11px]" value={h?.horizonMin} onChange={(e) => setHorizonMin(Number(e.target.value))} aria-label="Time window for the odds">
            {horizons.map((x) => <option key={x.horizonMin} value={x.horizonMin}>within {x.label}</option>)}
          </Select>
        )}
      </div>

      {projection === undefined ? (
        <p className="text-muted">Reading this token&apos;s price history…</p>
      ) : !h ? (
        <p className="text-muted">Not enough price history for this token to say what to expect from it, so there are no suggestions. Set targets yourself.</p>
      ) : (
        <>
          <p className="leading-relaxed text-muted">
            From a random moment in this token&apos;s last {Math.round(projection!.basedOn.spanHours)} hours, its price reached <span className="num text-foreground">+{h.p50.toFixed(1)}%</span> within {h.label} half the time, <span className="num text-foreground">+{h.p75.toFixed(1)}%</span> a quarter of the time and{" "}
            <span className="num text-foreground">+{h.p90.toFixed(1)}%</span> one time in ten; at some point it typically dipped <span className="num text-foreground">{h.typicalDip.toFixed(1)}%</span> first. That is what it has done, not a promise.
            {h.independent < 8 && <span className="text-warn"> This rests on only about {h.independent} separate {h.label} stretches, so treat it loosely.</span>}
            {projection!.volatility && projection!.volatility.ratio > 1.5 && <span className="text-warn"> It is moving {projection!.volatility.ratio.toFixed(1)}x more than usual right now.</span>}
          </p>
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-muted">Suggest:</span>
            {(Object.keys(LADDER_PROFILES) as LadderProfile[]).map((p) => (
              <Button key={p} type="button" size="sm" variant="outline" title={`${PROFILE_HINT[p]} (${Math.round(LADDER_PROFILES[p].from * 100)}% of past windows down to ${Math.round(LADDER_PROFILES[p].to * 100)}%)`} onClick={() => apply(p)}>{PROFILE_LABEL[p]}</Button>
            ))}
            <Button type="button" size="sm" variant="ghost" onClick={() => onChange(defaultLadder.map(({ gainPct, sellPct }) => ({ gainPct, sellPct })))}>{defaultLabel}</Button>
          </div>
        </>
      )}

      <div className="space-y-1.5">
        {value.map((r, i) => {
          const odds = h && r.gainPct > 0 ? hitRate(h, r.gainPct) : null;
          return (
            <div key={i} className="grid grid-cols-[auto_1fr_1fr_auto] items-center gap-2">
              <span className="text-muted">T{i + 1}</span>
              <label className="flex items-center gap-1">
                <Input type="number" min="0" step="0.1" value={r.gainPct} onChange={(e) => set(i, { gainPct: Number(e.target.value) })} aria-label={`Target ${i + 1} gain`} />
                <span className="text-muted">%</span>
              </label>
              <label className="flex items-center gap-1">
                <span className="text-muted">sell</span>
                <Input type="number" min="0" max="100" step="1" value={r.sellPct} onChange={(e) => set(i, { sellPct: Number(e.target.value) })} aria-label={`Target ${i + 1} share to sell`} />
                <span className="text-muted">%</span>
              </label>
              <Button type="button" variant="ghost" size="sm" disabled={value.length <= 1} onClick={() => onChange(value.filter((_, j) => j !== i))}>×</Button>
              {odds !== null && h && (
                <div className="col-span-4 -mt-1 pl-6 text-[11px] text-muted">
                  {odds === 0 ? `never reached within ${h.label} in its history: a target above anything it has done` : `reached within ${h.label} in about ${Math.max(1, Math.round(odds * 100))}% of its past windows`}
                </div>
              )}
            </div>
          );
        })}
      </div>
      <div className="flex items-center justify-between">
        <Button type="button" variant="outline" size="sm" disabled={value.length >= 10} onClick={() => onChange([...value, { gainPct: (value[value.length - 1]?.gainPct ?? 0) + 10, sellPct: 25 }])}>Add target</Button>
        <span className="text-[11px] text-muted">Each sells a share of what you hold; the last sells the rest.</span>
      </div>
    </div>
  );
}
