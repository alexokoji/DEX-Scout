"use client";

import { useLivePrice } from "@/lib/livePrices";
import { PnL } from "@/components/ui/badges";
import { price, usd } from "@/lib/format";
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

/** A position's current price and how far it has moved from the price paid, live (the same move the profit targets track). */
export function LivePositionPrice({ chain, address, fallbackUsd, entryPriceUsd }: { chain: string; address: string; fallbackUsd: number; entryPriceUsd: number }) {
  const live = useLivePrice(chain, address);
  const usd = live?.priceUsd ?? fallbackUsd;
  const pct = entryPriceUsd > 0 ? (usd / entryPriceUsd - 1) * 100 : 0;
  return (
    <div>
      <div className="text-muted">Current {live && <span className="ml-1 text-[10px] text-up">● live</span>}</div>
      <div className="num">{price(usd)}</div>
      <div className={cn("num text-[11px]", pct > 0.05 ? "text-up" : pct < -0.05 ? "text-down" : "text-muted")}>{pct >= 0 ? "+" : ""}{pct.toFixed(2)}%</div>
    </div>
  );
}

/**
 * A position's profit, live. The headline is what it has made on price (worth now, against the tokens at the price paid),
 * the same move the targets track. The fees paid to buy are shown beside it with the figure after them, because on a small
 * position they are a large share of the cost: up 2% on price can still be down 7% after a $0.01 fee on a $0.10 buy.
 */
export function LivePositionPnL({ chain, address, fallbackUsd, amount, entryPriceUsd, costBasisUsd, className }: { chain: string; address: string; fallbackUsd: number; amount: number; entryPriceUsd: number; costBasisUsd: number; className?: string }) {
  const live = useLivePrice(chain, address);
  const px = live?.priceUsd ?? fallbackUsd;
  const value = px * amount;
  const swapCost = amount * entryPriceUsd;
  const priceUsd = value - swapCost;
  const pricePct = entryPriceUsd > 0 ? (px / entryPriceUsd - 1) * 100 : 0;
  const fees = Math.max(0, costBasisUsd - swapCost);
  const net = value - costBasisUsd;
  const netPct = costBasisUsd > 0 ? (net / costBasisUsd) * 100 : 0;
  return (
    <div className="text-right">
      <PnL value={priceUsd} pct={pricePct} className={className} />
      {fees >= 0.0001 && (
        <div className="text-[11px] text-muted" title="Fees paid to buy (network and priority) are part of what the position cost. This is the result if the position were sold at this price.">
          {usd(fees, fees < 0.1 ? 4 : 2)} fees paid · <span className={cn("num", net > 0 ? "text-up" : net < 0 ? "text-down" : "")}>after fees {net >= 0 ? "+" : "-"}{usd(Math.abs(net), Math.abs(net) < 0.1 ? 4 : 2)} ({netPct >= 0 ? "+" : ""}{netPct.toFixed(1)}%)</span>
        </div>
      )}
    </div>
  );
}

/** The live market price as a labelled row, for the trade panel. */
export function useMarketPrice(chain: string, address: string) {
  return useLivePrice(chain, address);
}
