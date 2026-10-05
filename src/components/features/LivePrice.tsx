"use client";

import { useLivePrice } from "@/lib/livePrices";
import { price } from "@/lib/format";
import { cn } from "@/lib/utils";

const secondsAgo = (ms: number) => Math.max(0, Math.round((Date.now() - ms) / 1000));

/** The token's price, refreshed every few seconds from the market data source; before the first update it shows the stored price with its age. */
export function LiveTokenPrice({ chain, address, fallbackUsd, fallbackAt }: { chain: string; address: string; fallbackUsd: number; fallbackAt: string | Date | null }) {
  const live = useLivePrice(chain, address);
  const usd = live?.priceUsd ?? fallbackUsd;
  const at = live?.at ?? (fallbackAt ? new Date(fallbackAt).getTime() : null);
  const age = at ? secondsAgo(at) : null;
  const fresh = age !== null && age <= 30;
  return (
    <span className="inline-flex items-baseline gap-2">
      <span>{price(usd)}</span>
      <span className={cn("inline-flex items-center gap-1 text-[10px] font-normal", fresh ? "text-up" : "text-warn")} title={live ? "Fetched from the market data source a few seconds ago and refreshed continuously" : "Stored price; a live one is loading"}>
        <span className={cn("h-1.5 w-1.5 rounded-full", fresh ? "animate-pulse bg-up" : "bg-warn")} />
        {live ? (age! < 2 ? "live" : `live · ${age}s`) : age === null ? "loading…" : age < 90 ? `${age}s ago` : `${Math.round(age / 60)}m ago`}
      </span>
    </span>
  );
}

/** A position's current price and return, live. The return is against what the position actually cost (swap plus fees). */
export function LivePositionPrice({ chain, address, fallbackUsd, amount, costBasisUsd }: { chain: string; address: string; fallbackUsd: number; amount: number; costBasisUsd: number }) {
  const live = useLivePrice(chain, address);
  const usd = live?.priceUsd ?? fallbackUsd;
  const value = usd * amount;
  const pct = costBasisUsd > 0 ? (value / costBasisUsd - 1) * 100 : 0;
  return (
    <div>
      <div className="text-muted">Current {live && <span className="ml-1 text-[10px] text-up">● live</span>}</div>
      <div className="num">{price(usd)}</div>
      <div className={cn("num text-[11px]", pct > 0.05 ? "text-up" : pct < -0.05 ? "text-down" : "text-muted")}>{pct >= 0 ? "+" : ""}{pct.toFixed(2)}%</div>
    </div>
  );
}

/** The live market price as a labelled row, for the trade panel. */
export function useMarketPrice(chain: string, address: string) {
  return useLivePrice(chain, address);
}
