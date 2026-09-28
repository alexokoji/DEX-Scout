/**
 * Multi-chain market data from DexScreener (discovery, pairs) and GeckoTerminal (OHLCV).
 * Chain specifics (authority checks, holders, honeypot heuristics) are injected as `onChain` handlers per family.
 */
import { CHAINS, normalizeAddress, type ChainFamily } from "../chains";
import type { Candle, ChainId, OnChainRaw, Timeframe, TokenSnapshot } from "../types";
import { TIMEFRAME_MINUTES } from "../types";
import { env } from "../../lib/env";
import { getJson } from "./http";
import type { TokenDataProvider } from "./interfaces";

export type OnChainHandler = (chain: ChainId, address: string, snapshot: TokenSnapshot) => Promise<OnChainRaw>;

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

export class DexScreenerDataProvider implements TokenDataProvider {
  readonly name = "dexscreener";
  readonly kind = "LIVE" as const;

  constructor(private onChain: Record<ChainFamily, OnChainHandler>) {}

  private base = () => env().MARKET_DATA_URL;

  async discover(chain: ChainId): Promise<TokenSnapshot[]> {
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
    const out: TokenSnapshot[] = [];
    for (let i = 0; i < all.length; i += 30) {
      const chunk = all.slice(i, i + 30);
      const pairs = await getJson<DsPair[]>(`${this.base()}/tokens/v1/${slug}/${chunk.join(",")}`).catch(() => []);
      const byToken = new Map<string, DsPair[]>();
      for (const p of pairs) byToken.set(p.baseToken.address, [...(byToken.get(p.baseToken.address) ?? []), p]);
      for (const ps of byToken.values()) {
        const s = this.toSnapshot(chain, ps);
        if (s) out.push(s);
      }
    }
    return out;
  }

  async getSnapshot(chain: ChainId, address: string): Promise<TokenSnapshot | null> {
    const slug = CHAINS[chain].dexScreenerId;
    const pairs = await getJson<DsPair[]>(`${this.base()}/tokens/v1/${slug}/${address}`);
    const want = normalizeAddress(chain, address);
    const mine = pairs.filter((p) => normalizeAddress(chain, p.baseToken.address) === want);
    const snap = mine.length ? this.toSnapshot(chain, mine) : null;
    if (snap) await enrichHolders(snap);
    return snap;
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

  async getCandles(chain: ChainId, address: string, timeframe: Timeframe, limit: number): Promise<Candle[]> {
    const snap = await this.getSnapshot(chain, address);
    if (!snap) return [];
    const m = TIMEFRAME_MINUTES[timeframe];
    const unit = m >= 60 ? "hour" : "minute";
    const agg = m >= 60 ? m / 60 : m;
    const url = `https://api.geckoterminal.com/api/v2/networks/${CHAINS[chain].geckoId}/pools/${snap.poolAddress}/ohlcv/${unit}?aggregate=${agg}&limit=${Math.min(limit, 1000)}`;
    const j = await getJson<{ data: { attributes: { ohlcv_list: number[][] } } }>(url);
    return j.data.attributes.ohlcv_list
      .map(([t, o, h, l, c, v]) => ({ time: t, open: o, high: h, low: l, close: c, volume: v, buys: 0, sells: 0 }))
      .sort((a, b) => a.time - b.time);
  }

  async getOnChain(chain: ChainId, address: string, snapshot: TokenSnapshot): Promise<OnChainRaw> {
    return this.onChain[CHAINS[chain].family](chain, address, snapshot);
  }
}
