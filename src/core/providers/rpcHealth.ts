import { rpcCandidates } from "../chains";
import type { ChainId } from "../types";

/**
 * In-process memory of which free RPC endpoints are behaving. Without it, failover pays for a dead or slow
 * endpoint's full timeout on every single call; with it, the last endpoint that worked is tried first and one
 * that just failed is skipped for a minute (it still gets retried afterwards, and is used if everything is cooling).
 */
const badUntil = new Map<string, number>();
const lastGood = new Map<ChainId, string>();
const COOLDOWN_MS = 60_000;

export function orderedRpcs(chain: ChainId): string[] {
  const all = rpcCandidates(chain);
  const now = Date.now();
  const live = all.filter((u) => (badUntil.get(u) ?? 0) <= now);
  const pool = live.length ? live : all;
  const good = lastGood.get(chain);
  return good && pool.includes(good) ? [good, ...pool.filter((u) => u !== good)] : pool;
}

export function markRpcGood(chain: ChainId, url: string): void {
  lastGood.set(chain, url);
  badUntil.delete(url);
}

/** Host of the endpoint that last answered for this chain (for the Integrations health check; never the full URL, which may embed a key). */
export function rpcGoodHost(chain: ChainId): string | null {
  const u = lastGood.get(chain);
  try { return u ? new URL(u).host : null; } catch { return null; }
}

export function markRpcBad(url: string): void {
  badUntil.set(url, Date.now() + COOLDOWN_MS);
}

/** test helper */
export function resetRpcHealth(): void {
  badUntil.clear();
  lastGood.clear();
}
