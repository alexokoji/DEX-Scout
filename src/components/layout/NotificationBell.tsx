"use client";

import { Bell } from "lucide-react";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";

interface Item {
  id: string;
  title: string;
  body: string;
  url: string;
  createdAt: string;
  readAt: string | null;
}

const SEEN_KEY = "dexscout:lastNotified";

const readSeen = (): number | null => {
  try {
    const v = localStorage.getItem(SEEN_KEY);
    return v ? Number(v) : null;
  } catch {
    return null;
  }
};
const writeSeen = (t: number) => {
  try {
    localStorage.setItem(SEEN_KEY, String(t));
  } catch {
    /* storage blocked */
  }
};

/**
 * Header bell. Polls while the app is open, raises a toast (and a browser notification if the user allowed them) for
 * anything new, and lists recent ones. Alerts for when the app is closed come from the ntfy/Discord channels
 * configured in Settings → Notifications.
 */
export function NotificationBell() {
  const [items, setItems] = useState<Item[]>([]);
  const [unread, setUnread] = useState(0);
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const load = async () => {
      const r = await fetch("/api/notifications").catch(() => null);
      if (!r?.ok) return;
      const j = (await r.json()) as { unread: number; items: Item[] };
      setItems(j.items);
      setUnread(j.unread);

      const seen = readSeen();
      const fresh = j.items.filter((i) => seen !== null && new Date(i.createdAt).getTime() > seen && !i.readAt).reverse();
      for (const i of fresh) {
        toast.warning(i.title, { description: i.body, duration: 15_000 });
        if (typeof Notification !== "undefined" && Notification.permission === "granted") {
          try {
            new Notification(i.title, { body: i.body, tag: i.id });
          } catch {
            /* some browsers only allow notifications from a service worker */
          }
        }
      }
      const newest = j.items[0] ? new Date(j.items[0].createdAt).getTime() : null;
      writeSeen(newest !== null && (seen === null || newest > seen) ? newest : (seen ?? Date.now()));
    };
    void load();
    const id = setInterval(() => document.visibilityState === "visible" && void load(), 15_000);
    const onVisible = () => document.visibilityState === "visible" && void load();
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      clearInterval(id);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, []);

  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => !box.current?.contains(e.target as Node) && setOpen(false);
    document.addEventListener("mousedown", away);
    return () => document.removeEventListener("mousedown", away);
  }, [open]);

  async function toggle() {
    const next = !open;
    setOpen(next);
    if (next && unread > 0) {
      setUnread(0);
      await fetch("/api/notifications/read", { method: "POST" }).catch(() => {});
    }
  }

  return (
    // On a phone the panel anchors to the (sticky) header and spans the screen with side margins; from `sm` up it hangs under the bell.
    <div className="sm:relative" ref={box}>
      <button onClick={toggle} className="relative rounded-md p-2 text-muted hover:text-foreground" aria-label={`Notifications${unread ? `, ${unread} unread` : ""}`}>
        <Bell className="h-4 w-4" />
        {unread > 0 && <span className="absolute -right-0.5 -top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-warn px-1 text-[10px] font-semibold text-black">{unread > 9 ? "9+" : unread}</span>}
      </button>
      {open && (
        <div className="absolute inset-x-3 top-full z-40 mt-2 overflow-hidden rounded-lg border border-border bg-surface shadow-lg sm:inset-x-auto sm:right-0 sm:w-80">
          <div className="flex items-center justify-between border-b border-border px-3 py-2 text-xs">
            <span className="font-medium">Notifications</span>
            <Link href="/settings/notifications" onClick={() => setOpen(false)} className="text-accent">Phone alerts</Link>
          </div>
          <div className="max-h-[min(24rem,60vh)] divide-y divide-border overflow-y-auto">
            {items.length === 0 && <div className="px-3 py-6 text-center text-xs text-muted">Nothing yet. You&apos;ll be told here when a buy or sell needs your signature, a trade confirms or fails, or a position is in trouble.</div>}
            {items.map((i) => (
              <Link key={i.id} href={i.url} onClick={() => setOpen(false)} className={cn("block px-3 py-2 text-xs hover:bg-surface2", !i.readAt && "bg-surface2/60")}>
                <div className="font-medium">{i.title}</div>
                <div className="mt-0.5 text-muted">{i.body}</div>
                <div className="mt-1 text-[10px] text-muted">{new Date(i.createdAt).toLocaleString()}</div>
              </Link>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
