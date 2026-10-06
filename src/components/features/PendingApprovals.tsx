"use client";

import { useEffect, useState } from "react";
import { Badge } from "@/components/ui/badges";
import { Button } from "@/components/ui/button";
import { Card, CardHeader } from "@/components/ui/card";
import { CHAINS } from "@/core/chains";
import type { ChainId } from "@/core/types";
import { usd } from "@/lib/format";
import { useApproveTrade } from "./useApproveTrade";

interface Pending {
  id: string;
  side: string;
  kind: string;
  inputUsd: number;
  priceImpactPct: number;
  reason: string | null;
  expiresAt: string;
  unsignedTxBase64: string | null;
  token: { symbol: string; chain: string };
}

/**
 * LIVE approval queue. The bot can only PREPARE unsigned transactions; nothing moves until the user's wallet signs.
 * This is the "no withdrawal authority" guarantee for automated trading, on every chain.
 */
export function PendingApprovals() {
  const approveTrade = useApproveTrade();
  const [items, setItems] = useState<Pending[]>([]);
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    let stop = false;
    const load = async () => {
      const r = await fetch("/api/trades/pending").catch(() => null);
      if (r?.ok && !stop) setItems(await r.json());
    };
    void load();
    const id = setInterval(() => document.visibilityState === "visible" && void load(), 10_000);
    return () => {
      stop = true;
      clearInterval(id);
    };
  }, []);

  if (!items.length) return null;

  async function approve(t: Pending) {
    setBusy(t.id);
    try {
      await approveTrade({ id: t.id, chain: t.token.chain as ChainId });
    } finally {
      setBusy(null);
    }
  }
  return (
    <Card className="border-warn/40">
      <CardHeader title="Awaiting your wallet signature" sub="LIVE trades prepared by you or the bot. Approve in your wallet to execute; ignore to let them expire." />
      <div className="divide-y divide-border">
        {items.map((t) => (
          <div key={t.id} className="flex flex-wrap items-center justify-between gap-2 px-4 py-3 text-sm">
            <div>
              <div className="flex items-center gap-2">
                <Badge tone={t.side === "BUY" ? "green" : "red"}>{t.side}</Badge>
                <span className="font-medium">{t.token.symbol}</span>
                <Badge>{CHAINS[t.token.chain as ChainId]?.name ?? t.token.chain}</Badge>
                <span className="num">{usd(t.inputUsd)}</span>
                <Badge>{t.kind.replace("_", " ")}</Badge>
              </div>
              <div className="mt-0.5 text-[11px] text-muted">impact {t.priceImpactPct.toFixed(2)}% {t.reason ? `· ${t.reason}` : ""}</div>
            </div>
            <Button size="sm" disabled={busy === t.id} onClick={() => approve(t)}>{busy === t.id ? "Waiting…" : "Review & sign"}</Button>
          </div>
        ))}
      </div>
    </Card>
  );
}
