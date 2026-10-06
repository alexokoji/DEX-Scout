"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent } from "@/components/ui/form";
import { useProjection } from "@/lib/useProjection";
import { TargetsEditor, type TargetRow } from "./TargetsEditor";

/** This position's own profit targets, and a way to change them (independent of the default and of every other position). */
export function PositionTargets({ positionId, chain, address, symbol, targets, armed }: { positionId: string; chain: string; address: string; symbol: string; targets: { level: number; gainPct: number; sellPct: number }[]; armed: boolean }) {
  const router = useRouter();
  const current: TargetRow[] = targets.map(({ gainPct, sellPct }) => ({ gainPct, sellPct }));
  const [open, setOpen] = useState(false);
  const [rows, setRows] = useState<TargetRow[]>(current);
  const [busy, setBusy] = useState(false);
  const projection = useProjection(chain, address);

  async function save() {
    setBusy(true);
    try {
      const r = await fetch(`/api/positions/${positionId}/targets`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ targets: rows }) });
      const j = await r.json();
      if (!r.ok) {
        toast.error(j.violations?.[0] ?? j.error ?? "Couldn't change the targets", { duration: 15_000 });
        return;
      }
      toast.success(`${symbol} now has its own targets: ${(j.targets as { gainPct: number }[]).map((t) => `+${t.gainPct}%`).join(", ")}`);
      setOpen(false);
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <button type="button" className="text-[11px] text-accent hover:underline" onClick={() => { setRows(current); setOpen(true); }}>
        Targets: {targets.map((t) => `+${t.gainPct}%`).join(", ")} · edit
      </button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent title={`Targets for ${symbol}`} description="Only this position. From now on its targets start again at the first one, each selling a share of what you hold, measured from your entry price.">
          <div className="space-y-3">
            {armed && <p className="rounded-md border border-warn/30 bg-warn/10 p-2 text-xs text-warn">Auto-sell is armed for this position at its current targets, so they can&apos;t be changed until you cancel it (its orders sit with the venue). Cancel auto-sell, change the targets, then arm it again.</p>}
            <TargetsEditor value={rows} onChange={setRows} projection={projection} defaultLadder={current} defaultLabel="Current" />
            <div className="flex gap-2">
              <Button variant="outline" className="flex-1" onClick={() => setOpen(false)}>Cancel</Button>
              <Button className="flex-1" disabled={busy || armed} onClick={save}>{busy ? "Saving…" : "Save targets"}</Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
