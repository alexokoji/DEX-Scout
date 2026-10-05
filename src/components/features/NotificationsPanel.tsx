"use client";

import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { Input, Label, Switch } from "@/components/ui/form";

interface Prefs {
  ntfyTopic: string | null;
  discordWebhook: string | null;
  muted: string[];
}

const CATEGORIES: { id: string; title: string; sub: string }[] = [
  { id: "approvals", title: "Waiting for your signature", sub: "A buy the bot queued, sell orders ready to arm after a buy, a target or emergency sell, and one that expired unsigned" },
  { id: "results", title: "Trade results", sub: "Profit taken (with the percent made), a buy confirmed, or a trade that failed" },
  { id: "positions", title: "Position alerts", sub: "A position's health turning to warning or emergency (liquidity drop, dangerous holders…)" },
  { id: "system", title: "System problems", sub: "The scanner stopped running, so prices and signals are going stale" },
];

/** Where to be told that a target sell is waiting for your signature. The in-app bell always works; these add your phone. */
export function NotificationsPanel({ initial }: { initial: Prefs }) {
  const [ntfy, setNtfy] = useState(initial.ntfyTopic ?? "");
  const [discord, setDiscord] = useState(initial.discordWebhook ?? "");
  const [muted, setMuted] = useState<string[]>(initial.muted ?? []);
  const [busy, setBusy] = useState(false);
  const [perm, setPerm] = useState<string>(typeof Notification === "undefined" ? "unsupported" : Notification.permission);

  async function save(): Promise<boolean> {
    setBusy(true);
    try {
      const r = await fetch("/api/notifications/prefs", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ ntfyTopic: ntfy.trim() || null, discordWebhook: discord.trim() || null, muted }) });
      const j = await r.json();
      if (!r.ok) {
        toast.error(j.issues?.[0]?.message ?? j.error ?? "Could not save");
        return false;
      }
      toast.success("Saved");
      return true;
    } finally {
      setBusy(false);
    }
  }

  async function test() {
    if (!(await save())) return;
    setBusy(true);
    try {
      const r = await fetch("/api/notifications/test", { method: "POST" });
      const j = await r.json();
      if (!r.ok) return void toast.error(j.error ?? "Test failed");
      const results = j.results as { channel: string; ok: boolean; error?: string }[];
      if (!results.length) return void toast.message("Nothing to test yet — add an ntfy topic or a Discord webhook first.");
      for (const x of results) (x.ok ? toast.success : toast.error)(x.ok ? `Test sent via ${x.channel}` : `${x.channel} failed: ${x.error}`);
    } finally {
      setBusy(false);
    }
  }

  async function allowBrowser() {
    if (typeof Notification === "undefined") return;
    setPerm(await Notification.requestPermission());
  }

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader title="What to be told about" sub="Applies to the bell and to your phone channels." />
        <CardBody className="space-y-3">
          {CATEGORIES.map((c) => (
            <div key={c.id} className="flex items-center justify-between gap-3">
              <label htmlFor={`cat-${c.id}`} className="text-sm">
                <div className="font-medium">{c.title}</div>
                <div className="text-xs text-muted">{c.sub}</div>
              </label>
              <Switch id={`cat-${c.id}`} checked={!muted.includes(c.id)} onCheckedChange={(on) => setMuted((m) => (on ? m.filter((x) => x !== c.id) : [...m, c.id]))} />
            </div>
          ))}
          <Button size="sm" onClick={save} disabled={busy}>Save</Button>
        </CardBody>
      </Card>

      <Card>
        <CardHeader title="When the app is open" sub="The bell in the top bar: a banner appears the moment something needs you." />
        <CardBody className="flex flex-wrap items-center gap-3 text-sm">
          <span className="text-muted">Browser pop-ups: {perm === "granted" ? "on" : perm === "denied" ? "blocked in your browser settings" : perm === "unsupported" ? "not supported here" : "off"}</span>
          {perm === "default" && <Button size="sm" variant="outline" onClick={allowBrowser}>Allow browser notifications</Button>}
        </CardBody>
      </Card>

      <Card>
        <CardHeader title="When the app is closed (optional, free)" sub="Pick either or both. A queued sell expires after 10 minutes and a bot buy after 15, so being told promptly matters." />
        <CardBody className="space-y-4">
          <div>
            <Label hint="easiest: no account">ntfy topic</Label>
            <Input value={ntfy} onChange={(e) => setNtfy(e.target.value)} placeholder="e.g. dexscout-k3j9x2m7q" autoComplete="off" />
            <p className="mt-1 text-xs text-muted">
              Install the free <a className="text-accent" href="https://ntfy.sh" target="_blank" rel="noreferrer">ntfy</a> app (iOS / Android) and subscribe to this exact topic. Anyone who knows the topic name can read it, so make it long and random.
            </p>
          </div>
          <div>
            <Label hint="optional">Discord webhook URL</Label>
            <Input value={discord} onChange={(e) => setDiscord(e.target.value)} placeholder="https://discord.com/api/webhooks/…" autoComplete="off" />
            <p className="mt-1 text-xs text-muted">In Discord: channel settings → Integrations → Webhooks → New webhook → Copy URL. Treat the URL like a password.</p>
          </div>
          <div className="flex gap-2">
            <Button onClick={save} disabled={busy}>Save</Button>
            <Button variant="outline" onClick={test} disabled={busy}>Save &amp; send test</Button>
          </div>
        </CardBody>
      </Card>
    </div>
  );
}
