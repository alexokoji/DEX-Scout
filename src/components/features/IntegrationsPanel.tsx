"use client";

import { useState } from "react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badges";
import { Button } from "@/components/ui/button";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import type { IntegrationView } from "@/lib/integrations";

interface Check {
  id: string;
  ok: boolean;
  ms: number;
  detail: string;
}

// which health checks belong to which integration row
const CHECKS_FOR: Record<string, (id: string) => boolean> = {
  "evm-rpc": (id) => id.startsWith("rpc:") && id !== "rpc:solana",
  "solana-rpc": (id) => id === "rpc:solana",
  "market-data": (id) => id.startsWith("market-data:"),
  "solana-swaps": (id) => id === "swaps:jupiter",
  "evm-swaps": (id) => id === "swaps:paraswap" || id === "swaps:kyberswap",
};

const STATUS = {
  yours: { tone: "green", label: "your key active" },
  free: { tone: "blue", label: "free built-in active" },
  missing: { tone: "red", label: "needs setting" },
} as const;

export function IntegrationsPanel({ items, mock }: { items: IntegrationView[]; mock: boolean }) {
  const [checks, setChecks] = useState<Check[] | null>(null);
  const [busy, setBusy] = useState(false);

  async function run() {
    setBusy(true);
    try {
      const r = await fetch("/api/integrations/health");
      const j = await r.json();
      if (!r.ok) throw new Error(j.error ?? "Check failed");
      if (j.mock) toast.message("Mock data mode is on, so there are no live connections to test.");
      setChecks(j.checks);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Check failed");
    } finally {
      setBusy(false);
    }
  }

  const required = items.filter((i) => i.kind === "required");
  const optional = items.filter((i) => i.kind === "optional");
  const failing = checks?.filter((c) => !c.ok).length ?? 0;

  const row = (i: IntegrationView) => {
    const s = STATUS[i.status];
    const mine = checks?.filter((c) => CHECKS_FOR[i.id]?.(c.id)) ?? [];
    return (
      <div key={i.id} className="space-y-2 border-b border-border/60 px-4 py-3 last:border-0">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="font-medium">{i.name}</div>
          <Badge tone={s.tone}>{s.label}</Badge>
        </div>
        <div className="text-xs text-muted">{i.powers}</div>
        {i.freeDefault && <div className="text-xs">{i.status === "yours" ? "Yours is tried first; the free default stays as backup. " : ""}<span className="text-muted">Without a key: {i.freeDefault}</span></div>}
        {mine.length > 0 && (
          <ul className="space-y-0.5 text-xs">
            {mine.map((c) => (
              <li key={c.id} className={c.ok ? "text-up" : "text-down"}>
                {c.ok ? "✓" : "✗"} {c.id.includes(":") ? c.id.split(":")[1] : c.id} · {c.ms}ms · {c.detail}
              </li>
            ))}
          </ul>
        )}
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs">
          <span className="text-muted">Variable{i.envVars.length > 1 ? "s" : ""}: {i.envVars.map((v) => <code key={v} className={`mr-1 rounded bg-surface2 px-1 ${i.configured.includes(v) ? "text-up" : ""}`}>{v}</code>)}</span>
          <a className="text-accent" href={i.getUrl} target="_blank" rel="noreferrer">Get one: {i.getLabel} ↗</a>
        </div>
        <div className="text-[11px] text-muted">{i.note}</div>
      </div>
    );
  };

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader
          title="Check connections"
          sub="Calls every provider right now (read-only, no key needed, nothing is signed or sent) so you can see what actually works from this server."
          right={<Button onClick={run} disabled={busy || mock}>{busy ? "Checking…" : "Run check"}</Button>}
        />
        <CardBody className="text-xs">
          {mock ? <span className="text-muted">Mock data mode is on, so there are no live connections to test.</span> : !checks ? <span className="text-muted">Not run yet.</span> : failing === 0 ? <span className="text-up">All {checks.length} checks passed.</span> : <span className="text-down">{failing} of {checks.length} checks failed. Failing rows are marked below; a failing free endpoint is normal and the next backup is used automatically.</span>}
        </CardBody>
      </Card>

      <Card>
        <CardHeader title="Set these once" sub="Your own database and secrets. Nothing else is required to scan and trade." />
        <div>{required.map(row)}</div>
      </Card>

      <Card>
        <CardHeader title="Optional upgrades" sub="Every item below already works with no key. A key only adds speed, higher limits or extra data." />
        <div>{optional.map(row)}</div>
      </Card>
    </div>
  );
}
