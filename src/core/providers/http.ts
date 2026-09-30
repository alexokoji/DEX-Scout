export async function getJson<T>(url: string, init?: RequestInit, timeoutMs = 10_000): Promise<T> {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...init, signal: ctl.signal, cache: "no-store" });
    if (!res.ok) throw new Error(`HTTP ${res.status} from ${new URL(url).host}`);
    return (await res.json()) as T;
  } finally {
    clearTimeout(t);
  }
}

/** Minimal JSON-RPC 2.0 call (used for EVM nodes). */
export async function rpcCall<T>(url: string, method: string, params: unknown[] = [], timeoutMs = 10_000): Promise<T> {
  const j = await getJson<{ result?: T; error?: { message: string } }>(
    url,
    { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) },
    timeoutMs,
  );
  if (j.error) throw new Error(j.error.message);
  return j.result as T;
}

/**
 * Caps any promise's wall-clock, independent of whatever timeouts (or lack of them) the work inside it
 * carries on its own. Use this wherever a single call's worst case — a slow provider, retries, a shared
 * pacing queue's wait — could otherwise threaten a whole request's budget (a serverless function's hard
 * cap; a `Promise.all` batch that waits for its slowest member). The underlying work isn't cancelled —
 * JS can't do that generically — it just keeps running in the background and its eventual result is
 * discarded, which is fine for read-only lookups like these.
 */
export function withTimeout<T>(p: Promise<T>, ms: number, label = "operation"): Promise<T> {
  return Promise.race([p, new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms))]);
}
