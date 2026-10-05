"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badges";
import { Button } from "@/components/ui/button";
import { Card, CardHeader } from "@/components/ui/card";
import { CHAINS } from "@/core/chains";
import type { ChainId } from "@/core/types";
import { usd } from "@/lib/format";
import { explainWalletError } from "@/lib/txErrors";
import { useSigner } from "./useSigner";

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
  const router = useRouter();
  const signer = useSigner();
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
    const chain = t.token.chain as ChainId;
    if (!signer.ensureConnected(chain)) return;
    setBusy(t.id);
    try {
      // A queued trade's quote and (on Solana) blockhash go stale while it waits, and wallets refuse or fail to
      // simulate a stale transaction. Rebuild it fresh right now; this also re-checks it still passes the safety limits.
      const fr = await fetch("/api/trades/refresh", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ tradeId: t.id, wallet: signer.addressFor(chain) ?? undefined }) });
      const fj = await fr.json();
      if (!fr.ok) {
        toast.error(fj.violations?.[0] ?? fj.error ?? "This trade can no longer be approved", { duration: 15_000 });
        router.refresh();
        return;
      }
      const signature = await signer.signAndSend(chain, fj.unsignedTxBase64 as string);
      const r = await fetch("/api/trades/execute", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ tradeId: t.id, signature }) });
      const j = await r.json();
      if (!r.ok) toast.error(`Your wallet sent the transaction (${signature.slice(0, 10)}…) but recording it failed: ${j.error ?? "unknown error"}. Check your wallet's activity before retrying.`);
      else toast.success("Submitted — awaiting confirmation");
      router.refresh();
    } catch (e) {
      console.error("[approval] wallet error", e);
      toast.error(explainWalletError(e), { duration: 15_000 });
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
