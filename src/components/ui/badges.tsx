import { cn } from "@/lib/utils";

const TONES = {
  green: "bg-up/15 text-up border-up/30",
  red: "bg-down/15 text-down border-down/30",
  amber: "bg-warn/15 text-warn border-warn/30",
  blue: "bg-accent/15 text-accent border-accent/30",
  gray: "bg-surface2 text-muted border-border",
} as const;

export function Badge({ tone = "gray", children, className }: { tone?: keyof typeof TONES; children: React.ReactNode; className?: string }) {
  return <span className={cn("inline-flex items-center rounded border px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide", TONES[tone], className)}>{children}</span>;
}

const RISK: Record<string, [keyof typeof TONES, string]> = {
  LOWER: ["green", "Lower risk"],
  MODERATE: ["amber", "Moderate risk"],
  HIGH: ["red", "High risk"],
  CRITICAL: ["red", "Critical risk"],
};
export function RiskBadge({ level }: { level: string }) {
  const [tone, label] = RISK[level] ?? ["gray", level];
  return <Badge tone={tone}>{label}</Badge>;
}

export function SignalBadge({ type }: { type?: string | null }) {
  if (!type) return <span className="text-muted">—</span>;
  return <Badge tone={type === "BUY" ? "green" : type === "WATCH" ? "blue" : type === "EXIT" ? "amber" : "gray"}>{type}</Badge>;
}

/** Makes it impossible to confuse simulated and real activity. */
export function EnvBadge({ env, source }: { env?: string; source?: string }) {
  return (
    <span className="inline-flex gap-1">
      {env && <Badge tone={env === "LIVE" ? "red" : env === "PAPER" ? "amber" : "gray"}>{env}</Badge>}
      {source === "MOCK" && <Badge tone="gray">MOCK DATA</Badge>}
    </span>
  );
}

export function PnL({ value, pct, className }: { value?: number; pct?: number; className?: string }) {
  const v = value ?? pct ?? 0;
  return (
    <span className={cn("num", v > 0 ? "text-up" : v < 0 ? "text-down" : "text-muted", className)}>
      {value !== undefined && `${value >= 0 ? "+" : "-"}$${Math.abs(value).toFixed(2)}`}
      {value !== undefined && pct !== undefined && " "}
      {pct !== undefined && `(${pct >= 0 ? "+" : ""}${pct.toFixed(2)}%)`}
    </span>
  );
}

export function Change({ value }: { value: number }) {
  return <span className={cn("num", value > 0 ? "text-up" : value < 0 ? "text-down" : "text-muted")}>{`${value > 0 ? "+" : ""}${value.toFixed(2)}%`}</span>;
}

export function HealthBadge({ health }: { health: string }) {
  const tone = health === "HOLD" ? "green" : health === "MONITOR" ? "blue" : health === "WARNING" ? "amber" : "red";
  return <Badge tone={tone}>{health === "HOLD" ? "HOLD / MONITOR" : health}</Badge>;
}

export function ScoreBar({ score }: { score: number }) {
  const color = score >= 70 ? "bg-up" : score >= 55 ? "bg-accent" : "bg-muted";
  return (
    <div className="flex items-center gap-2">
      <div className="h-1.5 w-14 overflow-hidden rounded bg-surface2">
        <div className={cn("h-full", color)} style={{ width: `${Math.min(100, score)}%` }} />
      </div>
      <span className="num text-xs">{score.toFixed(0)}</span>
    </div>
  );
}
