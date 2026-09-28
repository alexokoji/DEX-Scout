"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent } from "@/components/ui/form";

export function BotControls({ status }: { status: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [confirmStop, setConfirmStop] = useState(false);

  async function call(action: "start" | "pause" | "stop") {
    setBusy(true);
    try {
      const r = await fetch(`/api/bot/${action}`, { method: "POST" });
      const j = await r.json();
      if (!r.ok) toast.error(j.error ?? "Action failed");
      else toast.success(action === "start" ? "Bot started" : action === "pause" ? "Bot paused" : "Emergency stop engaged: no new trades");
      setConfirmStop(false);
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-wrap gap-2">
      {status !== "ACTIVE" && <Button variant="buy" disabled={busy} onClick={() => call("start")}>Start bot</Button>}
      {status === "ACTIVE" && <Button variant="outline" disabled={busy} onClick={() => call("pause")}>Pause</Button>}
      <Button variant="danger" disabled={busy || status === "DISABLED"} onClick={() => setConfirmStop(true)}>Emergency stop</Button>
      <Dialog open={confirmStop} onOpenChange={setConfirmStop}>
        <DialogContent title="Emergency stop" description="Stops all NEW entries immediately.">
          <div className="space-y-3 text-sm">
            <p className="text-xs text-muted">Existing positions are not sold or modified. They continue to be monitored and follow your configured profit targets and emergency protection.</p>
            <div className="flex gap-2">
              <Button variant="outline" className="flex-1" onClick={() => setConfirmStop(false)}>Cancel</Button>
              <Button variant="danger" className="flex-1" disabled={busy} onClick={() => call("stop")}>Stop new trades</Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}