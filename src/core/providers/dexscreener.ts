/**
 * Multi-chain market data, blended from two independent free/public sources so neither one's rate
 * limits or downtime take discovery out entirely: DexScreener (token-profiles/boosts + pairs) and
 * GeckoTerminal (new_pools + OHLCV). Neither needs an API key. Chain specifics (authority checks,
 * holders, honeypot heuristics) are injected as `onChain` handlers per family.
 */
import { CHAINS, normalizeAddress, type ChainFamily } from "../chains";
import type { Candle, ChainId, OnChainRaw, Timeframe, TokenSnapshot } from "../types";
import { TIMEFRAME_MINUTES } from "../types";
import { env } from "../../lib/env";
import { getJson } from "./http";
import type { TokenDataProvider } from "./interfaces";

export type OnChainHandler = (chain: ChainId, address: string, snapshot: TokenSnapshot) => Promise<OnChainRaw>;

/**
 * GeckoTerminal's free public tier is good for roughly 30 requests/minute, and it's used here for both
 * per-chain discovery (new_pools) and per-token candles — both of which can legitimately need dozens of
 * calls inside a single scan cycle. Left unpaced, a batch of concurrent analysis calls bursts well past
 * that in a few seconds and gets 429'd (reproduced in production: 6/6 candle fetches failed this way in
 * one run). A single process-wide queue paces every call to this host at roughly one every 2.2s
 * (~27/min, with headroom).
 *
 * The per-call timeout is deliberately tight (6s, vs `getJson`'s 10s default): a normal GeckoTerminal
 * response lands well under a second (observed ~0.4-1s), so anything approaching 10s is already abnormal.
 * `maxAttempts`/`timeoutMs` are overridable per call: discovery retries (its tokens are worth waiting for,
 * and there are only ~6 calls/cycle), but candles are best-effort enrichment a token's analysis can — and
 * now does — complete without (see analyzeSnapshot), so they get one fast attempt and never block a
 * queue slot waiting on a retry. An earlier 10s-timeout/2-retry version of this let one bad call cost up
 * to ~34s while blocking every other call queued behind it — enough by itself to blow Hobby's 60s
 * function cap (reproduced in production as a hard FUNCTION_INVOCATION_TIMEOUT).
 */
let geckoChain: Promise<unknown> = Promise.resolve();
const GECKO_MIN_GAP_MS = 2200;
const GECKO_TIMEOUT_MS = 6_000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function geckoFetch<T>(url: string, opts?: { timeoutMs?: number; maxAttempts?: number }): Promise<T> {
  const timeoutMs = opts?.timeoutMs ?? GECKO_TIMEOUT_MS;
  const maxAttempts = opts?.maxAttempts ?? 3;
  const p = geckoChain.then(async () => {
    await sleep(GECKO_MIN_GAP_MS);
    for (let attempt = 0; ; attempt++) {
      try {
        return await getJson<T>(url, undefined, timeoutMs);
      } catch (err) {
        if (attempt >= maxAttempts - 1) throw err;
        await sleep(1000);
      }
    }
  });
  geckoChain = p.catch(() => {}); // one call's failure must not jam the queue for the calls behind it
  return p;
}

interface DsPair {
  chainId: string;
  dexId: string;
  pairAddress: string;
  baseToken: { address: string; name: string; symbol: string };
  priceUsd?: string;
  txns?: Record<string, { buys: number; sells: number }>;
  volume?: Record<string, number>;
  priceChange?: Record<string, number>;
  liquidity?: { usd?: number };
  fdv?: number;
  marketCap?: number;
  pairCreatedAt?: number;
}

const holderHistory = new Map<string, { t: number; holders: number }[]>();

/**
 * Optional holder counts via Birdeye (BIRDEYE_API_KEY, supports Solana and the major EVM chains).
 * Without a key holders stay -1 (unknown). Growth is derived from this process's own observations over ~1h.
 */
async function enrichHolders(s: TokenSnapshot): Promise<void> {
  const key = env().BIRDEYE_API_KEY;
  if (!key) return;
  const id = `${s.chain}:${s.address}`;
  const now = Date.now();
  const hist = holderHistory.get(id) ?? [];
  const last = hist[hist.length - 1];
  let holders = last && now - last.t < 5 * 60_000 ? last.holders : -1;
  if (holders < 0) {
    try {
      const j = await getJson<{ data?: { holder?: number } }>(`https://public-api.birdeye.so/defi/token_overview?address=${s.address}`, { headers: { "X-API-KEY": key, "x-chain": s.chain === "bsc" ? "bsc" : s.chain } });
      holders = j.data?.holder ?? -1;
    } catch {
      return;
    }
    if (holders >= 0) holderHistory.set(id, [...hist.filter((h) => now - h.t < 75 * 60_000), { t: now, holders }]);
  }
  if (holders < 0) return;
  const oldest = (holderHistory.get(id) ?? [])[0];
  s.holders = holders;
  s.holders1hAgo = oldest && now - oldest.t >= 30 * 60_000 ? oldest.holders : holders;
}

/** Shape of GeckoTerminal's `/networks/{network}/new_pools?include=base_token` response. */
interface GtPool {
  attributes: {
    base_token_price_usd: string | null;
    address: string;
    name: string;
    pool_created_at: string | null;
    fdv_usd: string | null;
    market_cap_usd: string | null;
    reserve_in_usd: string | null;
    price_change_percentage: Record<string, string>;
    transactions: Record<string, { buys: number; sells: number }>;
    volume_usd: Record<string, string>;
  };
  relationships: { base_token: { data: { id: string } }; dex?: { data: { id: string } } };
}
interface GtToken {
  id: string;
  attributes: { address: string; name: string; symbol: string; decimals: number };
}

export class DexScreenerDataProvider implements TokenDataProvider {
  readonly name = "dexscreener+geckoterminal";
  readonly kind = "LIVE" as const;

  constructor(private onChain: Record<ChainFamily, OnChainHandler>) {}

  private base = () => env().MARKET_DATA_URL;

  async discover(chain: ChainId): Promise<TokenSnapshot[]> {
    const [ds, gt] = await Promise.allSettled([this.discoverDexScreener(chain), this.discoverGeckoTerminal(chain)]);
    const dsList = ds.status === "fulfilled" ? ds.value : [];
    const gtList = gt.status === "fulfilled" ? gt.value : [];
    if (ds.status === "rejected" && gt.status === "rejected") {
      throw new Error(`discovery failed on both providers for ${chain}: ${String(ds.reason)} / ${String(gt.reason)}`);
    }
    // DexScreener has richer fields (multi-window volume, real market cap) — prefer it when both saw the token.
    const byAddress = new Map<string, TokenSnapshot>();
    for (const s of gtList) byAddress.set(s.address, s);
    for (const s of dsList) byAddress.set(s.address, s);
    return [...byAddress.values()];
  }

  private async discoverDexScreener(chain: ChainId): Promise<TokenSnapshot[]> {
    const slug = CHAINS[chain].dexScreenerId;
    const lists = await Promise.allSettled([
      getJson<{ chainId: string; tokenAddress: string }[]>(`${this.base()}/token-profiles/latest/v1`),
      getJson<{ chainId: string; tokenAddress: string }[]>(`${this.base()}/token-boosts/latest/v1`),
      getJson<{ chainId: string; tokenAddress: string }[]>(`${this.base()}/token-boosts/top/v1`),
    ]);
    const addrs = new Set<string>();
    for (const l of lists) {
      if (l.status === "fulfilled") for (const t of l.value) if (t.chainId === slug) addrs.add(t.tokenAddress);
    }
    if (addrs.size === 0 && lists.every((l) => l.status === "rejected")) throw new Error("DexScreener discovery failed");
    const all = [...addrs];
    const chunks: string[][] = [];
    for (let i = 0; i < all.length; i += 30) chunks.push(all.slice(i, i + 30));
    const pairLists = await Promise.all(
      chunks.map((chunk) => getJson<DsPair[]>(`${this.base()}/tokens/v1/${slug}/${chunk.join(",")}`).catch(() => [] as DsPair[])),
    );
    const out: TokenSnapshot[] = [];
    for (const pairs of pairLists) {
      const byToken = new Map<string, DsPair[]>();
      for (const p of pairs) byToken.set(p.baseToken.address, [...(byToken.get(p.baseToken.address) ?? []), p]);
      for (const ps of byToken.values()) {
        const s = this.toSnapshot(chain, ps);
        if (s) out.push(s);
      }
    }
    return out;
  }

  /** Independent, free/public discovery source: freshly created pools on GeckoTerminal, per chain. */
  private async discoverGeckoTerminal(chain: ChainId): Promise<TokenSnapshot[]> {
    const network = CHAINS[chain].geckoId;
    // Same one-call-per-chain cost as before, but rotated: `new_pools` is almost entirely brand-new micro-cap
    // pools (sub-$10k liquidity) that can never clear a real market-cap/liquidity band, so on its own it
    // starved the app of tradeable tokens. `trending_pools` surfaces established tokens with real liquidity
    // and volume (observed: $5M-$60M caps, $0.7M-$4M liquidity), so it runs on two of every three ticks and
    // `new_pools` on the third to keep early-stage discovery alive.
    const endpoint = Math.floor(Date.now() / 60_000) % 3 === 0 ? "new_pools" : "trending_pools";
    const j = await geckoFetch<{ data: GtPool[]; included?: GtToken[] }>(
      `https://api.geckoterminal.com/api/v2/networks/${network}/${endpoint}?include=base_token&page=1`,
    );
    const tokenById = new Map((j.included ?? []).map((t) => [t.id, t.attributes]));
    const out: TokenSnapshot[] = [];
    for (const pool of j.data ?? []) {
      const s = this.toSnapshotFromGecko(chain, pool, tokenById);
      if (s) out.push(s);
    }
    return out;
  }

  async getSnapshot(chain: ChainId, address: string): Promise<TokenSnapshot | null> {
    const slug = CHAINS[chain].dexScreenerId;
    const pairs = await getJson<DsPair[]>(`${this.base()}/tokens/v1/${slug}/${address}`);
    const want = normalizeAddress(chain, address);
    const mine = pairs.filter((p) => normalizeAddress(chain, p.baseToken.address) === want);
    const snap = (mine.length ? this.toSnapshot(chain, mine) : null) ?? (await this.snapshotFromGecko(chain, address));
    if (snap) await enrichHolders(snap);
    return snap;
  }

  /**
   * Discovery blends two sources, but snapshots used to come from DexScreener alone — so a token GeckoTerminal
   * surfaced (a trending pool, a brand-new chain DexScreener hasn't indexed yet) failed every later analysis with
   * "token not found" and was demoted. Fall back to GeckoTerminal's own pool data for it. Only reached when
   * DexScreener has nothing, so the shared GeckoTerminal queue isn't touched in the common case.
   */
  private async snapshotFromGecko(chain: ChainId, address: string): Promise<TokenSnapshot | null> {
    const network = CHAINS[chain].geckoId;
    const j = await geckoFetch<{ data?: GtPool[]; included?: GtToken[] }>(
      `https://api.geckoterminal.com/api/v2/networks/${network}/tokens/${address}/pools?include=base_token&page=1`,
      { timeoutMs: 5_000, maxAttempts: 1 },
    ).catch(() => null);
    if (!j?.data?.length) return null;
    const tokenById = new Map((j.included ?? []).map((t) => [t.id, t.attributes]));
    const want = normalizeAddress(chain, address);
    for (const pool of j.data) {
      const base = tokenById.get(pool.relationships.base_token.data.id);
      if (!base || normalizeAddress(chain, base.address) !== want) continue; // our token must be the pool's base token
      const s = this.toSnapshotFromGecko(chain, pool, tokenById);
      if (s) return s;
    }
    return null;
  }

  private toSnapshot(chain: ChainId, pairs: DsPair[]): TokenSnapshot | null {
    const p = [...pairs].sort((a, b) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0))[0];
    const price = Number(p.priceUsd);
    if (!(price > 0)) return null;
    const tx = (k: string) => p.txns?.[k] ?? { buys: 0, sells: 0 };
    const v = (k: string) => p.volume?.[k] ?? 0;
    const liq = p.liquidity?.usd ?? 0;
    return {
      chain,
      address: normalizeAddress(chain, p.baseToken.address),
      name: p.baseToken.name,
      symbol: p.baseToken.symbol,
      decimals: 0, // resolved lazily from the token contract when needed
      dex: p.dexId,
      poolAddress: p.pairAddress,
      poolCreatedAt: new Date(p.pairCreatedAt ?? Date.now()),
      pairCount: pairs.length,
      priceUsd: price,
      marketCapUsd: p.marketCap ?? p.fdv ?? 0,
      fdvUsd: p.fdv ?? p.marketCap ?? 0,
      liquidityUsd: liq,
      liquidity1hAgoUsd: liq, // not provided; trend is neutral until history accumulates in our DB
      volume5m: v("m5"),
      volume15m: (v("m5") + v("h1") / 4) / 2, // DexScreener has no 15m/30m buckets: interpolate
      volume30m: (v("m5") + v("h1") / 2) / 1.5,
      volume1h: v("h1"),
      volume24h: v("h24"),
      buys5m: tx("m5").buys,
      sells5m: tx("m5").sells,
      buys15m: Math.round((tx("m5").buys + tx("h1").buys / 4) / 2),
      sells15m: Math.round((tx("m5").sells + tx("h1").sells / 4) / 2),
      buys1h: tx("h1").buys,
      sells1h: tx("h1").sells,
      change5m: p.priceChange?.m5 ?? 0,
      change1h: p.priceChange?.h1 ?? 0,
      change24h: p.priceChange?.h24 ?? 0,
      holders: -1,
      holders1hAgo: -1,
      observedAt: new Date(),
      dataSource: "LIVE",
    };
  }

  private toSnapshotFromGecko(chain: ChainId, pool: GtPool, tokenById: Map<string, GtToken["attributes"]>): TokenSnapshot | null {
    const a = pool.attributes;
    const price = Number(a.base_token_price_usd);
    if (!(price > 0)) return null;
    const token = tokenById.get(pool.relationships.base_token.data.id);
    if (!token) return null; // can't identify the base token without the `include=base_token` join
    const tx = (k: string) => a.transactions?.[k] ?? { buys: 0, sells: 0 };
    const v = (k: string) => Number(a.volume_usd?.[k] ?? 0);
    const liq = Number(a.reserve_in_usd ?? 0);
    const fdv = Number(a.fdv_usd ?? 0);
    const mcap = Number(a.market_cap_usd ?? 0);
    const pct = (k: string) => Number(a.price_change_percentage?.[k] ?? 0);
    return {
      chain,
      address: normalizeAddress(chain, token.address),
      name: token.name,
      symbol: token.symbol,
      decimals: token.decimals,
      dex: pool.relationships.dex?.data.id ?? "unknown",
      poolAddress: a.address,
      poolCreatedAt: new Date(a.pool_created_at ?? Date.now()),
      pairCount: 1,
      priceUsd: price,
      marketCapUsd: mcap || fdv,
      fdvUsd: fdv || mcap,
      liquidityUsd: liq,
      liquidity1hAgoUsd: liq,
      volume5m: v("m5"),
      volume15m: v("m15"),
      volume30m: v("m30"),
      volume1h: v("h1"),
      volume24h: v("h24"),
      buys5m: tx("m5").buys,
      sells5m: tx("m5").sells,
      buys15m: tx("m15").buys,
      sells15m: tx("m15").sells,
      buys1h: tx("h1").buys,
      sells1h: tx("h1").sells,
      change5m: pct("m5"),
      change1h: pct("h1"),
      change24h: pct("h24"),
      holders: -1,
      holders1hAgo: -1,
      observedAt: new Date(),
      dataSource: "LIVE",
    };
  }

  async getCandles(chain: ChainId, address: string, timeframe: Timeframe, limit: number): Promise<Candle[]> {
    const snap = await this.getSnapshot(chain, address);
    if (!snap) return [];
    const m = TIMEFRAME_MINUTES[timeframe];
    const unit = m >= 60 ? "hour" : "minute";
    const agg = m >= 60 ? m / 60 : m;
    const url = `https://api.geckoterminal.com/api/v2/networks/${CHAINS[chain].geckoId}/pools/${snap.poolAddress}/ohlcv/${unit}?aggregate=${agg}&limit=${Math.min(limit, 1000)}`;
    // One fast attempt, no retry: candles are best-effort enrichment (analyzeSnapshot degrades gracefully
    // to an empty array), so a slow/rate-limited response should give up quickly rather than hold the
    // shared queue for a retry that would otherwise delay every other analysis in this batch.
    const j = await geckoFetch<{ data: { attributes: { ohlcv_list: number[][] } } }>(url, { timeoutMs: 4_000, maxAttempts: 1 });
    return j.data.attributes.ohlcv_list
      .map(([t, o, h, l, c, v]) => ({ time: t, open: o, high: h, low: l, close: c, volume: v, buys: 0, sells: 0 }))
      .sort((a, b) => a.time - b.time);
  }

  async getOnChain(chain: ChainId, address: string, snapshot: TokenSnapshot): Promise<OnChainRaw> {
    return this.onChain[CHAINS[chain].family](chain, address, snapshot);
  }
}
