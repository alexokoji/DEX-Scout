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
