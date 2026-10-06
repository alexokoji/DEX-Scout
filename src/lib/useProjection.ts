"use client";

import { useEffect, useState } from "react";
import type { Projection } from "@/core/analysis/projection";

/**
 * A token's projected rises (from its own price history). undefined while loading, null when there isn't enough history to say
 * anything, so the screen can tell "still working" from "nothing to show" instead of leaving a spinner or a guess.
 */
const FRESH_MS = 5 * 60_000;
const memo = new Map<string, { at: number; p: Projection | null }>();
const fresh = (h: { at: number } | undefined): h is { at: number; p: Projection | null } => !!h && Date.now() - h.at < FRESH_MS;

export function useProjection(chain: string, address: string): Projection | null | undefined {
  const key = `${chain}:${address.toLowerCase()}`;
  const [res, setRes] = useState<{ key: string; p: Projection | null } | null>(null);
  useEffect(() => {
    if (fresh(memo.get(key))) return;
    let live = true;
    fetch(`/api/tokens/${encodeURIComponent(address)}/projection?chain=${encodeURIComponent(chain)}`)
      .then((r) => (r.ok ? r.json() : { projection: null }))
      .then((j: { projection: Projection | null }) => {
        memo.set(key, { at: Date.now(), p: j.projection });
        if (live) setRes({ key, p: j.projection });
      })
      .catch(() => live && setRes({ key, p: null }));
    return () => {
      live = false;
    };
  }, [key, chain, address]);
  const hit = memo.get(key);
  if (fresh(hit)) return hit.p;
  return res && res.key === key ? res.p : undefined;
}
