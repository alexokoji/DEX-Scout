"use client";

import { useEffect, useSyncExternalStore } from "react";

/**
 * One shared poller for every live price on the page. Components subscribe to a `chain:address` key; while anything is
 * subscribed (and the tab is visible) the keys are fetched together every few seconds in a single request.
 */
export interface LivePrice {
  priceUsd: number;
  liquidityUsd: number;
  change5m: number;
  /** when the server fetched it (ms) */
  at: number;
}

const INTERVAL_MS = 5_000;
const store = new Map<string, LivePrice>();
const refs = new Map<string, number>();
const listeners = new Set<() => void>();
let timer: ReturnType<typeof setInterval> | null = null;
let version = 0;

const emit = () => {
  version++;
  listeners.forEach((l) => l());
};

async function poll() {
  if (typeof document !== "undefined" && document.visibilityState !== "visible") return;
  const keys = [...refs.keys()].slice(0, 30);
  if (!keys.length) return;
  try {
    const r = await fetch(`/api/prices?tokens=${encodeURIComponent(keys.join(","))}`, { cache: "no-store" });
    if (!r.ok) return;
    const j = (await r.json()) as { prices: Record<string, LivePrice> };
    for (const [k, v] of Object.entries(j.prices)) store.set(k, v);
    emit();
  } catch {
    /* keep showing the last price; its age is displayed */
  }
}

function retain(key: string) {
  refs.set(key, (refs.get(key) ?? 0) + 1);
  if (!timer) {
    timer = setInterval(poll, INTERVAL_MS);
    void poll();
  } else if (!store.has(key)) void poll();
  return () => {
    const n = (refs.get(key) ?? 1) - 1;
    if (n <= 0) refs.delete(key);
    else refs.set(key, n);
    if (!refs.size && timer) {
      clearInterval(timer);
      timer = null;
    }
  };
}

const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => void listeners.delete(l);
};

/** The latest live price for a token, or null until the first response (callers fall back to the server-rendered price). */
export function useLivePrice(chain: string, address: string): LivePrice | null {
  const key = `${chain}:${chain === "solana" ? address : address.toLowerCase()}`;
  useEffect(() => retain(key), [key]);
  useSyncExternalStore(subscribe, () => version, () => 0);
  return store.get(key) ?? null;
}
