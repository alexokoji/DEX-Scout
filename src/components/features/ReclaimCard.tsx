"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { usd } from "@/lib/format";
import { explainWalletError } from "@/lib/txErrors";
import { useSigner } from "./useSigner";

interface Reclaimable {
  wallet: string | null;
  accounts: { address: string; mint: string; symbol: string | null; native: number; usd: number }[];
  totalUsd: number;
  totalNative: number;
}

/**
 * Solana: buying a token for the first time opens a token account and locks a deposit in it; selling empties the account but leaves it
 * open with the deposit inside. This lists those empty accounts and closes them with one signature, which returns the deposits.
 */
export function ReclaimCard() {
  const router = useRouter();
  const signer = useSigner();
  const wallet = signer.addressFor("solana");
  const [loaded, setLoaded] = useState<{ wallet: string; info: Reclaimable } | null>(null);
  const [tick, setTick] = useState(0);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!wallet) return;
    let cancelled = false;
    (async () => {
      try {
        const r = await fetch(`/api/wallet/reclaim?wallet=${encodeURIComponent(wallet)}`);
        if (!r.ok || cancelled) return;
        const info = (await r.json()) as Reclaimable;
        if (!cancelled) setLoaded({ wallet, info });
      } catch {
        /* the card simply stays as it was */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [wallet, tick]);

  useEffect(() => {
    const t = setInterval(() => setTick((n) => n + 1), 30_000);
    return () => clearInterval(t);
  }, []);

  const info = wallet && loaded?.wallet === wallet ? loaded.info : null;
  if (!info || info.accounts.length === 0) return null;

  async function reclaim() {
    if (!wallet) return;
    setBusy(true);
    try {
      const b = await fetch("/api/wallet/reclaim", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ wallet }) });
      const bj = await b.json();
      if (!b.ok) {
        toast.error(bj.error ?? "Could not prepare the transaction", { duration: 15_000 });
        return;
      }
      let refund = 0;
      for (const t of bj.transactions as { transaction: string }[]) {
        const signature = await signer.signAndSend("solana", t.transaction);
        const c = await fetch("/api/wallet/reclaim/confirm", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ signature, wallet }) });
        const cj = await c.json();
        if (!c.ok) {
          toast.error(cj.error ?? "The close could not be confirmed", { duration: 15_000 });
          return;
        }
        refund += cj.refundUsd ?? 0;
      }
      toast.success(refund > 0 ? `${usd(refund, 4)} returned to your wallet` : "Submitted: it will show in your wallet once confirmed");
      setTick((n) => n + 1);
      router.refresh();
    } catch (e) {
      toast.error(explainWalletError(e), { duration: 15_000 });
    } finally {
      setBusy(false);
    }
  }

  const n = info.accounts.length;
  return (
    <Card>
      <CardHeader title="Deposits you can get back" sub="Not a fee: the chain locks a small deposit in each token account it opens for you, and keeps it until the empty account is closed." />
      <CardBody className="space-y-3 text-sm">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <div className="num text-lg font-semibold">{usd(info.totalUsd, 4)}</div>
            <div className="text-xs text-muted">
              held in {n} empty token account{n === 1 ? "" : "s"}
              {" · "}
              {info.accounts.slice(0, 6).map((a) => a.symbol ?? `${a.mint.slice(0, 4)}…`).join(", ")}
              {n > 6 ? ` and ${n - 6} more` : ""}
            </div>
          </div>
          <Button disabled={busy} onClick={reclaim}>{busy ? "Working…" : `Get ${usd(info.totalUsd, 4)} back`}</Button>
        </div>
        <p className="text-[11px] leading-relaxed text-muted">
          One signature in your wallet closes the empty accounts and sends the deposits back. Only accounts holding none of their token are closed, and the chain checks each one first. Buying the same token again simply opens a new account.
        </p>
      </CardBody>
    </Card>
  );
}
