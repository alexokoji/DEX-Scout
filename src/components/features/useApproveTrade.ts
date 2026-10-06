"use client";

import { useRouter } from "next/navigation";
import { toast } from "sonner";
import type { ChainId } from "@/core/types";
import { explainWalletError } from "@/lib/txErrors";
import { useSigner } from "./useSigner";

/**
 * Take a trade the server has PREPARED (a sell you just asked for, or a buy/sell the bot queued) through the wallet:
 * connect if needed, rebuild it fresh (a queued trade's quote and blockhash go stale while it waits, and this also re-checks
 * the safety limits), have the wallet sign and send it, then record the signature. Resolves true once it was submitted.
 * Every failure is reported to the user here, so callers only need to know whether it went through.
 */
export function useApproveTrade() {
  const router = useRouter();
  const signer = useSigner();

  return async function approve(trade: { id: string; chain: ChainId }): Promise<boolean> {
    if (!(await signer.ensureConnected(trade.chain))) return false;
    try {
      const fr = await fetch("/api/trades/refresh", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ tradeId: trade.id, wallet: signer.addressFor(trade.chain) ?? undefined }) });
      const fj = await fr.json();
      if (!fr.ok) {
        toast.error(fj.violations?.[0] ?? fj.error ?? "This trade can no longer be approved", { duration: 15_000 });
        router.refresh();
        return false;
      }
      const signature = await signer.signAndSend(trade.chain, fj.unsignedTxBase64 as string);
      const r = await fetch("/api/trades/execute", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ tradeId: trade.id, signature }) });
      const j = await r.json();
      if (!r.ok) {
        toast.error(`Your wallet sent the transaction (${signature.slice(0, 10)}…) but recording it failed: ${j.error ?? "unknown error"}. Check your wallet's activity before retrying.`);
        router.refresh();
        return false;
      }
      toast.success("Submitted — awaiting confirmation");
      router.refresh();
      return true;
    } catch (e) {
      console.error("[approval] wallet error", e);
      toast.error(explainWalletError(e), { duration: 15_000 });
      return false;
    }
  };
}
