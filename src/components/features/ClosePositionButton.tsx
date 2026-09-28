"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, Select, Label } from "@/components/ui/form";

export function ClosePositionButton({ id, symbol, environment }: { id: string; symbol: string; environment: string }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [pct, setPct] = useState("100");
  const [busy, setBusy] = useState(false);

  async function go() {
    setBusy(true);
    try {
      const r = await fetch(`/api/positions/${id}/close`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ percent: Number(pct) }) });
      const j = await r.json();
      if (!r.ok) toast.error(j.error ?? "Close failed");
      else if (j.ok === false) toast.error(`Sell failed: ${j.reason}`);
      else if (j.awaitingSignature) toast.success("Sell prepared — approve it in your wallet on the Trades page");
      else toast.success(`Sold ${pct}% of ${symbol}`);
      setOpen(false);
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <Button size="sm" variant="outline" onClick={() => setOpen(true)}>Sell</Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent title={`Sell ${symbol}`} description={environment === "PAPER" ? "Simulated sale at the current pool price." : "Prepares an unsigned transaction that your wallet must approve."}>
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