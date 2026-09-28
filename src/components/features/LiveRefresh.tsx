"use client";

import { RefreshCw } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { cn } from "@/lib/utils";

/**
 * Re-runs the server component data fetch on an interval while the tab is visible. This only refreshes the view;
 * scanning, monitoring and trading run in background workers and never depend on this component.
 */
export function LiveRefresh({ seconds = 15 }: { seconds?: number }) {
  const router = useRouter();
  const [on, setOn] = useState(true);
  const [spin, setSpin] = useState(false);

  useEffect(() => {
    if (!on) return;
    const id = setInterval(() => {
      if (document.visibilityState !== "visible") return;
      setSpin(true);
      router.refresh();
      setTimeout(() => setSpin(false), 800);
    }, seconds * 1000);
    return () => clearInterval(id);
  }, [on, seconds, router]);

  return (
    <button onClick={() => setOn((v) => !v)} className="inline-flex items-center gap-1.5 text-xs text-muted hover:text-foreground" title="Toggle live refresh">
      <RefreshCw className={cn("h-3.5 w-3.5", spin && "animate-spin")} />
      {on ? `Live · ${seconds}s` : "Paused"}
    </button>
  );
}
