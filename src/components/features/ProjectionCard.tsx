"use client";

import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { useProjection } from "@/lib/useProjection";

/**
 * What to expect from this token, from its own price history: for each time window, how far the price climbed at its best from a
 * random starting moment (the typical, the good and the rare outcome) and how far it dipped on the way. A base rate for setting
 * targets against, not a forecast, and it says how much history it rests on.
 */
export function ProjectionCard({ chain, address }: { chain: string; address: string }) {
  const p = useProjection(chain, address);
  return (
    <Card>
      <CardHeader title="Projected rise" sub="What this token has done, as a base rate for setting targets. Not a forecast." />
      <CardBody className="space-y-2 text-xs">
        {p === undefined ? (
          <div className="text-muted">Reading this token&apos;s price history…</div>
        ) : p === null ? (
          <div className="text-muted">Not enough price history for this token to say what to expect from it. Set targets from your own judgement.</div>
        ) : (
          <>
            <div className="overflow-x-auto">
              <table className="w-full text-left">
                <thead className="text-[11px] uppercase tracking-wider text-muted">
                  <tr>
                    <th className="py-1 pr-3 font-semibold">Within</th>
                    <th className="py-1 pr-3 font-semibold" title="the best rise reached, in half of the starting moments">Typical</th>
                    <th className="py-1 pr-3 font-semibold" title="reached in a quarter of the starting moments">Good</th>
                    <th className="py-1 pr-3 font-semibold" title="reached in one starting moment in ten">Rare</th>
                    <th className="py-1 font-semibold" title="how far it usually fell below the start at some point inside the window">Dips</th>
                  </tr>
                </thead>
                <tbody className="num">
                  {p.horizons.map((h) => (
                    <tr key={h.horizonMin} className="border-t border-border/60">
                      <td className="py-1 pr-3">{h.label}</td>
                      <td className="py-1 pr-3 text-up">+{h.p50.toFixed(1)}%</td>
                      <td className="py-1 pr-3 text-up">+{h.p75.toFixed(1)}%</td>
                      <td className="py-1 pr-3 text-up">+{h.p90.toFixed(1)}%</td>
                      <td className="py-1 text-down">{h.typicalDip.toFixed(1)}%</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="text-[11px] leading-relaxed text-muted">
              From every moment in its last {Math.round(p.basedOn.spanHours)} hours ({p.basedOn.candles.toLocaleString()} candles of {p.basedOn.timeframeMin} minutes): the best rise it reached afterwards, and how far it dipped on the way.
              {p.horizons.some((h) => h.independent < 8) && <span className="text-warn"> A window with few separate stretches behind it is a rough guide.</span>}
              {p.volatility && p.volatility.ratio > 1.5 && <span className="text-warn"> It is moving {p.volatility.ratio.toFixed(1)}x more than usual right now, so recent swings run bigger than these.</span>}
              {" "}Set each position&apos;s targets in the trade panel when you buy, or on the position afterwards: every target shows how often this token reached it.
            </p>
          </>
        )}
      </CardBody>
    </Card>
  );
}
