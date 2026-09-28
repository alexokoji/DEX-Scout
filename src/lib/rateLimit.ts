/**
 * Small in-memory sliding-window limiter. Per-process only: swap for Redis (e.g. Upstash) when running
 * multiple server instances.
 */
const hits = new Map<string, number[]>();

export function rateLimit(key: string, max: number, windowMs: number) {
  const now = Date.now();
  const arr = (hits.get(key) ?? []).filter((t) => now - t < windowMs);
  if (arr.length >= max) {
    hits.set(key, arr);
    return { ok: false as const, retryAfterSec: Math.ceil((windowMs - (now - arr[0])) / 1000) };
  }
  arr.push(now);
  hits.set(key, arr);
  if (hits.size > 10_000) for (const [k, v] of hits) if (!v.length || now - v[v.length - 1] > windowMs) hits.delete(k);
  return { ok: true as const, retryAfterSec: 0 };
}

/**
 * Rate limit that is shared across instances when Upstash Redis is configured
 * (UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN), and falls back to the in-memory limiter otherwise
 * (also if Redis is unreachable, so a Redis outage never blocks logins or trades).
 */
export async function rateLimitAsync(key: string, max: number, windowMs: number) {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return rateLimit(key, max, windowMs);
  try {
    const bucket = `rl:${key}:${Math.floor(Date.now() / windowMs)}`;
    const res = await fetch(`${url}/pipeline`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify([["INCR", bucket], ["PEXPIRE", bucket, windowMs]]),
      signal: AbortSignal.timeout(1500),
    });
    if (!res.ok) throw new Error(`redis ${res.status}`);
    const [{ result: count }] = (await res.json()) as { result: number }[];
    if (count > max) return { ok: false as const, retryAfterSec: Math.ceil((windowMs - (Date.now() % windowMs)) / 1000) };
    return { ok: true as const, retryAfterSec: 0 };
  } catch {
    return rateLimit(key, max, windowMs);
  }
}
