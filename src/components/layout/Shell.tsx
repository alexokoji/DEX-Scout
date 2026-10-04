"use client";

import { Activity, Bot, Briefcase, Gauge, LineChart, ListChecks, LogOut, Menu, Radar, Settings, Wallet, X, Zap, Layers, Plug, BellRing } from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useState } from "react";
import { Badge } from "@/components/ui/badges";
import { cn } from "@/lib/utils";
import { ConnectWalletButton } from "./ConnectWallet";
import { NotificationBell } from "./NotificationBell";

const NAV = [
  { href: "/", label: "Dashboard", icon: Gauge },
  { href: "/scanner", label: "Scanner", icon: Radar },
  { href: "/signals", label: "Signals", icon: Zap },
  { href: "/tokens", label: "Tokens", icon: LineChart },
  { href: "/positions", label: "Positions", icon: Layers },
  { href: "/trades", label: "Trades", icon: ListChecks },
  { href: "/portfolio", label: "Portfolio", icon: Briefcase },
  { href: "/bot", label: "Bot", icon: Bot },
  { href: "/strategies", label: "Strategies", icon: LineChart },
  { href: "/activity", label: "Activity", icon: Activity },
  { href: "/settings/trading", label: "Settings", icon: Settings },
  { href: "/settings/notifications", label: "Notifications", icon: BellRing },
  { href: "/settings/integrations", label: "Integrations", icon: Plug },
  { href: "/wallet", label: "Wallet", icon: Wallet },
];

export function Shell({ children, mock, liveEnabled, email, mode }: { children: React.ReactNode; mock: boolean; liveEnabled: boolean; email: string; mode: string }) {
  const path = usePathname();
  const router = useRouter();
  const [open, setOpen] = useState(false);

  const nav = (
    <nav className="flex flex-col gap-0.5 p-2">
      {NAV.map(({ href, label, icon: Icon }) => {
        const active = href === "/" ? path === "/" : path.startsWith(href.split("/").slice(0, 2).join("/"));
        return (
          <Link
            key={href}
            href={href}
            onClick={() => setOpen(false)}
            className={cn("flex items-center gap-3 rounded-md px-3 py-2 text-sm text-muted transition-colors hover:bg-surface2 hover:text-foreground", active && "bg-surface2 text-foreground")}
          >
            <Icon className={cn("h-4 w-4", active && "text-accent")} />
            {label}
          </Link>
        );
      })}
    </nav>
  );

  return (
    <div className="flex min-h-screen">
      <aside className="sticky top-0 hidden h-screen w-52 shrink-0 flex-col border-r border-border bg-surface md:flex">
        <div className="px-4 py-4 text-base font-semibold tracking-tight">
          DEX <span className="text-accent">Scout</span>
        </div>
        <div className="flex-1 overflow-y-auto">{nav}</div>
        <div className="border-t border-border p-3 text-xs text-muted">
          <div className="truncate">{email}</div>
          <button
            className="mt-2 flex items-center gap-2 hover:text-foreground"
            onClick={async () => {
              await fetch("/api/auth/logout", { method: "POST" });
              router.replace("/login");
              router.refresh();
            }}
          >
            <LogOut className="h-3.5 w-3.5" /> Sign out
          </button>
        </div>
      </aside>

      {open && (
        <div className="fixed inset-0 z-40 md:hidden">
          <div className="absolute inset-0 bg-black/70" onClick={() => setOpen(false)} />
          <div className="absolute left-0 top-0 h-full w-60 bg-surface">
            <div className="flex items-center justify-between px-4 py-4 font-semibold">
              <span>DEX <span className="text-accent">Scout</span></span>
              <button onClick={() => setOpen(false)}><X className="h-4 w-4" /></button>
            </div>
            {nav}
          </div>
        </div>
      )}

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-30 flex items-center justify-between gap-3 border-b border-border bg-background/90 px-4 py-2 backdrop-blur">
          <div className="flex items-center gap-3">
            <button className="md:hidden" onClick={() => setOpen(true)} aria-label="Open menu"><Menu className="h-5 w-5" /></button>
            <div className="flex flex-wrap items-center gap-1.5">
              {mock && <Badge tone="gray">MOCK DATA</Badge>}
              <Badge tone={mode === "LIVE" ? "red" : "gray"}>{mode === "MANUAL" ? "MANUAL MODE" : `${mode} TRADING`}</Badge>
              {!liveEnabled && <Badge tone="gray">LIVE DISABLED</Badge>}
            </div>
          </div>
          <div className="flex items-center gap-2">
            <NotificationBell />
            <ConnectWalletButton />
          </div>
        </header>
        <main className="fade-in min-w-0 flex-1 p-4 md:p-6">{children}</main>
      </div>
    </div>
  );
}
