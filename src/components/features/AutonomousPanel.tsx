"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badges";
import { Button } from "@/components/ui/button";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { Dialog, DialogContent, Input, Label } from "@/components/ui/form";
import { usd, usdPnl } from "@/lib/format";

type Family = "solana" | "evm";
interface Settings {
  enabled: boolean;
  dailyTargetUsd: number;
  dailyLossLimitUsd: number;
  givebackPct: number;
  maxConsecutiveLosses: number;
  cooldownMinutes: number;
  dayOffsetMinutes: number;
}
interface Overview {
  settings: Settings;
  wallets: { configured: boolean; wallets: { family: Family; address: string; exportedAt: string | null; balances: { chain: string; name: string; symbol: string; amount: number | null; usd: number | null }[] }[] };
  status: { running: boolean; blockedBy: string | null; decision: { state: string; canOpen: boolean; reason: string; realizedUsd: number; openDrawdownUsd: number; peakUsd: number; floorUsd: number | null; targetUsd: number; lossLimitUsd: number; consecutiveLosses: number }; openPositions: number; deployedUsd: number };
}

async function api<T>(path: string, body?: object): Promise<T> {
  const r = await fetch(path, body === undefined ? undefined : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const j = await r.json();
  if (!r.ok) throw new Error(j.error ?? "Request failed");
  return j as T;
}

const STATE_TONE: Record<string, "green" | "blue" | "amber" | "red" | "gray"> = { CHASING: "blue", ABOVE_TARGET: "green", TARGET_LOCKED: "green", LOSS_LIMIT: "red", COOLDOWN: "amber", OFF: "gray" };
const STATE_LABEL: Record<string, string> = { CHASING: "chasing the target", ABOVE_TARGET: "above target", TARGET_LOCKED: "target banked, stopped", LOSS_LIMIT: "loss limit, stopped", COOLDOWN: "paused", OFF: "off" };

/** Unattended trading: the bot wallet, the daily target and its limits, and how today is going. */
export function AutonomousPanel() {
  const [data, setData] = useState<Overview | null>(null);
  const [form, setForm] = useState<Settings | null>(null);
  const [tick, setTick] = useState(0);
  const [busy, setBusy] = useState<string | null>(null);
  const [exportFor, setExportFor] = useState<Family | null>(null);
  const [password, setPassword] = useState("");
  const [secret, setSecret] = useState<{ address: string; secret: string; format: string } | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const o = await api<Overview>("/api/autonomous");
        if (cancelled) return;
        setData(o);
        setForm((f) => f ?? o.settings);
      } catch {
        /* keep what is shown */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [tick]);
  useEffect(() => {
    const t = setInterval(() => document.visibilityState === "visible" && setTick((n) => n + 1), 20_000);
    return () => clearInterval(t);
  }, []);
  const refresh = useCallback(() => setTick((n) => n + 1), []);

  async function run(key: string, fn: () => Promise<void>) {
    setBusy(key);
    try {
      await fn();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed", { duration: 12_000 });
    } finally {
      setBusy(null);
      refresh();
    }
  }

  if (!data || !form) return <Card><CardBody className="text-sm text-muted">Loading…</CardBody></Card>;
  const { wallets, status } = data;
  const d = status.decision;
  const num = (k: keyof Settings) => (e: React.ChangeEvent<HTMLInputElement>) => setForm({ ...form, [k]: Number(e.target.value) });
  const progress = d.targetUsd > 0 ? Math.max(0, Math.min(1, d.realizedUsd / d.targetUsd)) : 0;
  const save = (enabled: boolean) => run("save", async () => {
    const s = await api<Settings>("/api/autonomous/settings", { ...form, enabled });
    setForm(s);
    toast.success(enabled ? "Unattended trading is ON: the bot trades with the bot wallet and no longer asks you to sign" : "Unattended trading is off. Open positions keep their sell targets.");
  });

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader title="How this works" />
        <CardBody className="space-y-2 text-xs leading-relaxed text-muted">
          <p>The bot trades with a <span className="text-foreground">separate bot wallet</span> whose key this server holds, so it can buy and sell without asking you to sign each trade. Fund it with only what you accept to lose. Your own wallet and its keys are never touched. The bot wallet can only be emptied to your own verified wallet, and you can export its key at any time.</p>
          <p>The daily target is a goal, not a promise: every rule below limits risk. When the loss limit is used up, or after the target if profit falls back to its floor, the bot stops <em>opening</em> trades for the day. It never sells a position just for being down: open positions keep their sell targets.</p>
        </CardBody>
      </Card>

      {data.settings.enabled && status.blockedBy && (
        <Card className="border-warn/40">
          <CardBody className="text-xs text-warn">Unattended trading is switched on, but nothing is trading because {status.blockedBy}. Unattended, &quot;auto trading&quot; in Trading settings, and the Start button on the Bot page are separate switches, and all of them have to be on.</CardBody>
        </Card>
      )}

      {!data.settings.enabled && (
        <Card>
          <CardBody className="space-y-1 text-xs text-muted">
            <p><span className="text-foreground">Why does this say off when auto trading is on?</span> They are two different things. <span className="text-foreground">Auto trading</span> (Trading settings) lets the bot pick trades, but each one still waits for you to sign it in your wallet. <span className="text-foreground">Unattended trading</span> (this page) is what lets it sign for itself with its own wallet, and it needs a bot wallet first. Switching Unattended on also turns the rest on for you.</p>
          </CardBody>
        </Card>
      )}

      {!wallets.configured && (
        <Card className="border-warn/40">
          <CardBody className="space-y-1 text-xs text-warn">
            <div className="font-medium">Not set up on this server yet</div>
            <p>The server needs a master key to seal the bot wallet&apos;s key. Generate one and add it as the <code>BOT_WALLET_KEY</code> environment variable (Vercel → Project → Settings → Environment Variables), then redeploy. Keep a copy somewhere safe: without it a bot wallet can&apos;t be opened.</p>
            <pre className="overflow-x-auto rounded bg-surface2 p-2 text-[11px] text-foreground">node -e &quot;console.log(require(&apos;crypto&apos;).randomBytes(32).toString(&apos;base64&apos;))&quot;</pre>
          </CardBody>
        </Card>
      )}

      <Card>
        <CardHeader title="Today" right={<Badge tone={STATE_TONE[d.state] ?? "gray"}>{STATE_LABEL[d.state] ?? d.state}</Badge>} />
        <CardBody className="space-y-3 text-sm">
          <div className="flex flex-wrap items-end justify-between gap-3">
            <div>
              <div className="num text-2xl font-semibold">{usdPnl(d.realizedUsd)}</div>
              <div className="text-xs text-muted">banked today, net of fees · target {usd(d.targetUsd)}</div>
            </div>
            <div className="text-right text-xs text-muted">
              <div>Open positions down: <span className="num text-foreground">{usdPnl(d.openDrawdownUsd)}</span></div>
              <div>Loss limit: <span className="num text-foreground">{usd(d.lossLimitUsd)}</span></div>
              {d.floorUsd !== null && <div>Floor: <span className="num text-foreground">{usd(d.floorUsd)}</span></div>}
            </div>
          </div>
          <div className="h-2 rounded bg-surface2"><div className="h-2 rounded bg-up" style={{ width: `${progress * 100}%` }} /></div>
          <p className="text-xs text-muted">{d.reason}</p>
          <p className="text-[11px] text-muted">{status.openPositions} open position{status.openPositions === 1 ? "" : "s"} in the bot wallet, {usd(status.deployedUsd)} deployed. Position size, how many at once, and the filters are the ones in <Link href="/settings/trading" className="text-accent">Trading settings</Link>.</p>
        </CardBody>
      </Card>

      <Card>
        <CardHeader title="Bot wallet" sub="Send funds to these addresses from your own wallet. One Solana address, and one EVM address that works on every EVM chain (each chain needs its own coin for fees)." />
        <CardBody className="space-y-4">
          {(["solana", "evm"] as const).map((family) => {
            const w = wallets.wallets.find((x) => x.family === family);
            return (
              <div key={family} className="rounded-md border border-border bg-surface2 p-3 text-xs">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="font-medium">{family === "solana" ? "Solana" : "EVM (Ethereum, Base, BNB Chain, …)"}</div>
                  {!w && <Button size="sm" disabled={!wallets.configured || busy === `create-${family}`} onClick={() => run(`create-${family}`, async () => { await api("/api/autonomous/wallet", { family }); toast.success("Bot wallet created"); })}>Create {family === "solana" ? "Solana" : "EVM"} bot wallet</Button>}
                </div>
                {w && (
                  <div className="mt-2 space-y-2">
                    <div className="flex flex-wrap items-center gap-2">
                      <code className="break-all rounded bg-surface px-2 py-1 text-[11px]">{w.address}</code>
                      <Button size="sm" variant="outline" onClick={() => { void navigator.clipboard?.writeText(w.address); toast.success("Address copied"); }}>Copy</Button>
                      <Button size="sm" variant="outline" onClick={() => { setExportFor(family); setSecret(null); setPassword(""); }}>Export key</Button>
                    </div>
                    <div className="divide-y divide-border/60">
                      {w.balances.filter((b) => (b.usd ?? 0) > 0 || family === "solana").map((b) => (
                        <div key={b.chain} className="flex items-center justify-between gap-2 py-1.5">
                          <span>{b.name}</span>
                          <span className="flex items-center gap-2">
                            <span className="num">{b.amount === null ? "balance unavailable" : `${b.amount.toLocaleString(undefined, { maximumSignificantDigits: 4 })} ${b.symbol} · ${usd(b.usd, 2)}`}</span>
                            {(b.usd ?? 0) > 0 && <Button size="sm" variant="outline" disabled={busy === `w-${b.chain}`} onClick={() => run(`w-${b.chain}`, async () => { const r = await api<{ amount: number; symbol: string; to: string }>("/api/autonomous/withdraw", { chain: b.chain }); toast.success(`Sent ${r.amount.toPrecision(4)} ${r.symbol} to your verified wallet`); })}>Withdraw</Button>}
                          </span>
                        </div>
                      ))}
                      {family === "evm" && w.balances.every((b) => (b.usd ?? 0) <= 0) && <div className="py-1.5 text-muted">No funds on any EVM chain yet.</div>}
                    </div>
                  </div>
                )}
              </div>
            );
          })}
          <p className="text-[11px] text-muted">Withdraw sends the whole balance of that chain&apos;s coin to your own verified wallet (the one on the <Link href="/wallet" className="text-accent">Wallet</Link> page). Tokens still held are sold by the bot at their targets, or all at once with the button below.</p>
        </CardBody>
      </Card>

      <Card>
        <CardHeader title="Daily target and limits" right={form.enabled || data.settings.enabled ? <Badge tone="green">unattended trading ON</Badge> : <Badge>off</Badge>} />
        <CardBody className="space-y-4">
          <div className="grid grid-cols-2 gap-3 md:grid-cols-3">
            <div><Label hint="USD, net of fees">Daily profit target</Label><Input type="number" min="0" step="any" value={form.dailyTargetUsd} onChange={num("dailyTargetUsd")} /></div>
            <div><Label hint="USD">Daily loss limit</Label><Input type="number" min="0" step="any" value={form.dailyLossLimitUsd} onChange={num("dailyLossLimitUsd")} /></div>
            <div><Label hint="% of the target">Give back after target</Label><Input type="number" min="0" max="100" step="any" value={form.givebackPct} onChange={num("givebackPct")} /></div>
            <div><Label hint="0 = never pause">Pause after losing closes</Label><Input type="number" min="0" step="1" value={form.maxConsecutiveLosses} onChange={num("maxConsecutiveLosses")} /></div>
            <div><Label hint="minutes">Pause for</Label><Input type="number" min="1" step="1" value={form.cooldownMinutes} onChange={num("cooldownMinutes")} /></div>
            <div><Label hint="minutes east of UTC">Day starts at offset</Label><Input type="number" step="30" value={form.dayOffsetMinutes} onChange={num("dayOffsetMinutes")} /></div>
          </div>
          <ul className="space-y-1 text-[11px] leading-relaxed text-muted">
            <li>• <span className="text-foreground">Target:</span> what the bot works toward each day. Once reached it keeps going and may go beyond it, but if the day&apos;s profit falls back from its peak by more than the give-back share of the target, it stops for the day (0 = stop as soon as the target is reached).</li>
            <li>• <span className="text-foreground">Loss limit:</span> when today&apos;s banked result plus what open positions are down reaches this, no new trades until tomorrow.</li>
            <li>• Entries are skipped when fees and price impact would eat the first profit target, so small trades on expensive chains aren&apos;t opened.</li>
          </ul>
          <div className="flex flex-wrap gap-2">
            {data.settings.enabled ? (
              <Button variant="outline" disabled={busy === "save"} onClick={() => save(false)}>Switch off</Button>
            ) : (
              <Button disabled={busy === "save" || !wallets.configured || wallets.wallets.length === 0} onClick={() => save(true)}>Save and switch ON</Button>
            )}
            {data.settings.enabled && <Button disabled={busy === "save"} onClick={() => save(true)}>Save changes</Button>}
            {!data.settings.enabled && <Button variant="outline" disabled={busy === "save"} onClick={() => save(false)}>Save only</Button>}
          </div>
          {!data.settings.enabled && (!wallets.configured || wallets.wallets.length === 0) && (
            <p className="text-[11px] text-warn">{!wallets.configured ? "Switch on is unavailable until the server has a BOT_WALLET_KEY (see above)." : "Switch on is unavailable until you create a bot wallet above."}</p>
          )}
        </CardBody>
      </Card>

      <Card className="border-down/30">
        <CardHeader title="Stop everything" />
        <CardBody className="flex flex-wrap items-center justify-between gap-3 text-xs text-muted">
          <p className="max-w-xl">Sells every open position in the bot wallet at market, right now, wins and losses alike. Switch unattended trading off first if you don&apos;t want it to open new ones.</p>
          <Button variant="danger" disabled={busy === "sellall" || status.openPositions === 0} onClick={() => { if (confirm(`Sell all ${status.openPositions} open bot position(s) now?`)) void run("sellall", async () => { const r = await api<{ sent: number; failed: { symbol: string; reason: string }[]; remaining: number }>("/api/autonomous/sell-all", {}); toast.success(`${r.sent} sale(s) sent${r.failed.length ? `, ${r.failed.length} failed: ${r.failed[0].symbol}: ${r.failed[0].reason}` : ""}${r.remaining ? `. ${r.remaining} left: press again` : ""}`, { duration: 15_000 }); }); }}>Sell everything now</Button>
        </CardBody>
      </Card>

      <Dialog open={exportFor !== null} onOpenChange={(o) => !o && setExportFor(null)}>
        <DialogContent title="Export bot wallet key" description="Anyone with this key controls the bot wallet. Import it into a wallet app you trust and keep it private.">
          {secret ? (
            <div className="space-y-3 text-xs">
              <div className="text-muted">{secret.format} for <code>{secret.address}</code></div>
              <code className="block break-all rounded bg-surface2 p-2 text-[11px]">{secret.secret}</code>
              <div className="flex gap-2"><Button variant="outline" onClick={() => { void navigator.clipboard?.writeText(secret.secret); toast.success("Copied"); }}>Copy</Button><Button onClick={() => { setSecret(null); setExportFor(null); }}>Done</Button></div>
            </div>
          ) : (
            <div className="space-y-3">
              <div><Label>Account password</Label><Input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" /></div>
              <Button disabled={!password || busy === "export"} onClick={() => run("export", async () => { setSecret(await api("/api/autonomous/export", { family: exportFor, password })); setPassword(""); })}>Show key</Button>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
