"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, Select, Label } from "@/components/ui/form";
import type { ChainId } from "@/core/types";
import { useApproveTrade } from "./useApproveTrade";
import { useSigner } from "./useSigner";

export function ClosePositionButton({ id, symbol, chain }: { id: string; symbol: string; chain: string }) {
  const router = useRouter();
  const signer = useSigner();
  const approveTrade = useApproveTrade();
  const [open, setOpen] = useState(false);
  const [pct, setPct] = useState("100");
  const [busy, setBusy] = useState(false);

  async function go() {
    setBusy(true);
    try {
      const r = await fetch(`/api/positions/${id}/close`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ percent: Number(pct), wallet: signer.addressFor(chain as ChainId) ?? undefined }) });
      const j = await r.json();
      if (!r.ok) {
        toast.error(j.error ?? "Close failed", { duration: 15_000 });
        return;
      }
      if (j.ok === false) {
        toast.error(`Sell failed: ${j.reason}`);
        return;
      }
      setOpen(false);
      router.refresh();
      // Open the wallet now, the way a buy does, instead of sending the user off to another page to find it. If they back out,
      // the sell stays on the Trades page (and is listed under "Awaiting your wallet signature") until it expires.
      if (j.awaitingSignature && j.tradeId) {
        const done = await approveTrade({ id: j.tradeId, chain: chain as ChainId });
        if (!done) toast.message("The sell is prepared but not signed. You can sign it from the Trades page until it expires.");
      } else {
        toast.success(`Sold ${pct}% of ${symbol}`);
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <Button size="sm" variant="outline" onClick={() => setOpen(true)}>Sell</Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent title={`Sell ${symbol}`} description="Your wallet will open to approve the sale. Nothing is sold until you approve it there.">
          <div className="space-y-3">
            <div>
              <Label>Amount to sell</Label>
              <Select value={pct} onChange={(e) => setPct(e.target.value)}>
                {[25, 50, 75, 100].map((p) => <option key={p} value={p}>{p}%</option>)}
              </Select>
            </div>
            <p className="text-xs text-muted">This is a manual exit you chose. The bot never sells a position just because it is at a loss.</p>
            <div className="flex gap-2">
              <Button variant="outline" className="flex-1" onClick={() => setOpen(false)}>Cancel</Button>
              <Button variant="danger" className="flex-1" disabled={busy} onClick={go}>{busy ? "Selling…" : "Confirm sell"}</Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
