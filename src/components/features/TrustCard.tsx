import { TrustBadge } from "@/components/ui/badges";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import type { TrustCheck } from "@/core/types";
import { timeAgo } from "@/lib/format";
import { cn } from "@/lib/utils";

interface Props {
  trust: { tier: string; summary: string; checks: TrustCheck[]; missing: string[]; sources: string[]; checkedAt?: Date | string } | null | undefined;
}

const MARK = { pass: "✓", fail: "✕", unknown: "?" } as const;
const TONE = { pass: "text-up", fail: "text-down", unknown: "text-muted" } as const;

/** Why a token is at its trust tier, check by check: what passed, what failed, and what nobody could confirm. */
export function TrustCard({ trust }: Props) {
  if (!trust) {
    return (
      <Card>
        <CardHeader title="Verification" right={<TrustBadge tier={null} />} sub="Independent checks run when the token is analysed" />
        <CardBody className="text-xs text-muted">This token hasn&apos;t been checked yet. Until it has, treat it as unverified.</CardBody>
      </Card>
    );
  }
  const bad = trust.tier === "DANGEROUS" || trust.tier === "RISKY";
  return (
    <Card>
      <CardHeader
        title="Verification"
        right={<TrustBadge tier={trust.tier} />}
        sub={`Checked by ${trust.sources.length ? trust.sources.join(", ") : "no service (none reachable)"}${trust.checkedAt ? ` · ${timeAgo(trust.checkedAt)}` : ""}`}
      />
      <CardBody className="space-y-2 text-xs">
        <p className={cn("rounded-md border p-2", bad ? "border-down/30 bg-down/10 text-down" : trust.tier === "UNPROVEN" ? "border-warn/30 bg-warn/10 text-warn" : "border-up/30 bg-up/10 text-up")}>{trust.summary}</p>
        <ul className="space-y-1">
          {trust.checks.map((c) => (
            <li key={c.id} className="flex gap-2">
              <span className={cn("w-3 shrink-0 text-center font-semibold", TONE[c.status])}>{MARK[c.status]}</span>
              <span>
                <span className="font-medium">{c.label}</span>
                <span className="text-muted"> — {c.detail}</span>
              </span>
            </li>
          ))}
        </ul>
        <p className="text-[11px] text-muted">Passing means independent checks found nothing wrong, not that the token can&apos;t lose value. Anyone can still dump, and prices can fall fast.</p>
      </CardBody>
    </Card>
  );
}
