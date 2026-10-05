import { isChainId, normalizeAddress } from "@/core/chains";
import { withTimeout } from "@/core/providers/http";
import { providers } from "@/core/providers/registry";
import type { ChainId, TokenSnapshot } from "@/core/types";
import { collections } from "@/lib/db";
import { applyLiveSnapshot } from "./tokenPrice";

/**
 * Live prices for the tokens on screen, straight from the market data source (not from the last scan), batched per chain
 * and shared for a few seconds between everyone asking so a busy page can't hammer the upstream.
 */
export const MAX_LIVE_TOKENS = 30;
const SHARE_MS = 3_000;
const cache = new Map<string, { at: number; snap: TokenSnapshot | null }>();

export interface LivePriceRow {
  priceUsd: number;
  liquidityUsd: number;
  change5m: number;
  /** when it was fetched (ms) */
  at: number;
}

/** `chain:address` keys → validated, normalised wanted tokens (bad or unknown ones are dropped). */
export function parseTokenKeys(raw: string) {
  return [...new Set(raw.split(",").map((s) => s.trim()).filter(Boolean))].slice(0, MAX_LIVE_TOKENS).flatMap((k) => {
    const i = k.indexOf(":");
    const chain = k.slice(0, i);
    const address = k.slice(i + 1);
    if (!(i > 0 && isChainId(chain) && /^[A-Za-z0-9]{20,64}$/.test(address))) return [];
    const a = normalizeAddress(chain as ChainId, address);
    return [{ chain: chain as ChainId, address: a, key: `${chain}:${a}` }];
  });
}

export async function livePrices(raw: string, now = Date.now()): Promise<Record<string, LivePriceRow>> {
  const wanted = parseTokenKeys(raw);
  const need = wanted.filter((w) => !(cache.get(w.key) && now - cache.get(w.key)!.at < SHARE_MS));
  const byChain = new Map<ChainId, string[]>();
  for (const w of need) byChain.set(w.chain, [...(byChain.get(w.chain) ?? []), w.address]);
  const p = providers();
  await Promise.all(
    [...byChain].map(async ([chain, addrs]) => {
      let snaps: TokenSnapshot[] = [];
      try {
        snaps = p.data.refresh ? await withTimeout(p.data.refresh(chain, addrs), 5_000, `prices(${chain})`) : (await Promise.all(addrs.map((a) => p.data.getSnapshot(chain, a).catch(() => null)))).filter((s): s is TokenSnapshot => !!s);
      } catch {
        /* leave these out: the page keeps showing the last price with its age */
      }
      const got = new Map(snaps.map((s) => [normalizeAddress(chain, s.address), s]));
      for (const a of addrs) cache.set(`${chain}:${a}`, { at: Date.now(), snap: got.get(a) ?? null });
    }),
  );

  // keep the stored price honest for anything that has gone stale (best effort, not awaited by the caller)
  const fresh = wanted.map((w) => ({ w, snap: cache.get(w.key)?.snap })).filter((x): x is { w: (typeof wanted)[number]; snap: TokenSnapshot } => !!x.snap && x.snap.priceUsd > 0);
  void (async () => {
    const col = await collections.tokens();
    for (const { w, snap } of fresh) {
      const t = await col.findOne({ chain: w.chain, address: w.address }, { projection: { _id: 1, lastScannedAt: 1 } });
      if (t && now - t.lastScannedAt.getTime() > 30_000) await applyLiveSnapshot(t._id, snap).catch(() => {});
    }
  })().catch(() => {});

  const out: Record<string, LivePriceRow> = {};
  for (const w of wanted) {
    const hit = cache.get(w.key);
    if (hit?.snap && hit.snap.priceUsd > 0) out[w.key] = { priceUsd: hit.snap.priceUsd, liquidityUsd: hit.snap.liquidityUsd, change5m: hit.snap.change5m, at: hit.at };
  }
  return out;
}

/** test hook */
export const _clearLivePriceCache = () => cache.clear();
