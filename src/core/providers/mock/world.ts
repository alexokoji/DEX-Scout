/**
 * Deterministic simulated market. Every value is a pure function of (token index, minute), so the Next.js
 * server and the background workers agree on prices without sharing state. New tokens "launch" on a fixed
 * cadence so the scanner keeps discovering fresh tokens as wall-clock time advances.
 *
 * Everything produced here is MOCK data and is labelled as such throughout the app.
 */
import { CHAIN_IDS, CHAINS } from "../../chains";
import type { Candle, ChainId, OnChainRaw, Timeframe, TokenSnapshot } from "../../types";
import { TIMEFRAME_MINUTES } from "../../types";

const EPOCH_MIN = Math.floor(Date.UTC(2026, 0, 1) / 60_000);
/** a new token launches every 3h on Solana and every 6h on each other chain */
const launchPeriod = (chain: ChainId) => (chain === "solana" ? 180 : 360);
const MAX_AGE_MIN = 21 * 1440;
const DAY = 1440;

export type Archetype = "pumper" | "steady" | "sleeper" | "dumper" | "rug" | "trap";

export interface MockTokenSpec {
  chain: ChainId;
  index: number;
  address: string;
  name: string;
  symbol: string;
  decimals: number;
  dex: string;
  poolAddress: string;
  launchMin: number;
  archetype: Archetype;
  supply: number;
  basePrice: number;
  baseLiq: number;
  baseVolPerMin: number;
  avgTradeUsd: number;
  sigma: number;
  eventPeriod: number;
  eventCenter: number;
  eventAmp: number;
  eventRise: number;
  T1: number;
  T2: number;
  p1: number;
  p2: number;
  holders0: number;
  holderGrowthPerDay: number;
  topHolderPct: number;
  top10HolderPct: number;
  mintRevoked: boolean;
  freezeRevoked: boolean;
  verified: boolean;
  rugMin: number | null;
  pairCount: number;
}

// ── deterministic randomness ────────────────────────────────────────────────
function mix(a: number, b: number): number {
  let h = (a ^ 0x9e3779b9) + Math.imul(b | 0, 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d);
  h = Math.imul(h ^ (h >>> 12), 0x297a2d39);
  h ^= h >>> 15;
  return h >>> 0;
}
/** uniform [0,1) */
function rnd(seed: number, k: number): number {
  return mix(seed, k) / 4294967296;
}
/** approx N(0,1) */
function gauss(seed: number, k: number): number {
  return rnd(seed, k * 2) + rnd(seed, k * 2 + 1) + rnd(seed + 7, k * 2) - 1.5;
}

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
function fakeAddress(seed: number, chain: ChainId, len = 44): string {
  let s = "";
  if (CHAINS[chain].family === "evm") {
    for (let i = 0; i < 40; i++) s += "0123456789abcdef"[mix(seed, i + 100) % 16];
    return "0x" + s;
  }
  for (let i = 0; i < len; i++) s += B58[mix(seed, i + 100) % 58];
  return s;
}

const PREFIX = ["Moon", "Pepe", "Doge", "Sol", "Wif", "Bonk", "Cat", "Frog", "Ape", "Giga", "Turbo", "Zen", "Pixel", "Nova", "Lazer", "Oro", "Kami", "Hyper", "Ninja", "Yeti", "Comet", "Blaze", "Cipher", "Vex"];
const SUFFIX = ["Coin", "Inu", "AI", "Cash", "Fi", "Dao", "Chad", "Rocket", "Labs", "Swap", "Punk", "Verse", "Bot", "Gold", "Wave"];
const DEXES = ["Raydium", "Orca", "Meteora", "PumpSwap"];

function pick<T>(arr: T[], seed: number, k: number): T {
  return arr[mix(seed, k) % arr.length];
}

const specCache = new Map<string, MockTokenSpec>();

const DEX_BY_CHAIN: Record<ChainId, string[]> = {
  solana: DEXES,
  ethereum: ["Uniswap", "SushiSwap", "Curve"],
  base: ["Aerodrome", "Uniswap", "BaseSwap"],
  bsc: ["PancakeSwap", "Biswap", "Uniswap"],
  arbitrum: ["Camelot", "Uniswap", "SushiSwap"],
  polygon: ["QuickSwap", "Uniswap", "SushiSwap"],
  robinhood: ["Uniswap", "Camelot"],
  avalanche: ["TraderJoe", "Pangolin", "Uniswap"],
  optimism: ["Velodrome", "Uniswap"],
  unichain: ["Uniswap"],
  linea: ["SyncSwap", "Uniswap"],
  sonic: ["Shadow", "SwapX"],
  berachain: ["Kodiak", "BEX"],
  hyperevm: ["HyperSwap", "KittenSwap"],
  ink: ["InkySwap", "Velodrome"],
  mantle: ["Agni", "MerchantMoe"],
  scroll: ["Ambient", "Uniswap"],
  blast: ["Thruster", "Ring"],
  world: ["Uniswap"],
  abstract: ["Aborean"],
  monad: ["Kuru"],
};

export function tokenSpec(index: number, chain: ChainId = "solana"): MockTokenSpec {
  const cacheKey = `${chain}:${index}`;
  const hit = specCache.get(cacheKey);
  if (hit) return hit;
  const s = index * 7919 + 13 + CHAIN_IDS.indexOf(chain) * 1_000_003;
  const r = (k: number) => rnd(s, k);

  const a = r(1);
  const archetype: Archetype =
    a < 0.34 ? "pumper" : a < 0.62 ? "steady" : a < 0.82 ? "sleeper" : a < 0.92 ? "dumper" : a < 0.96 ? "rug" : "trap";

  const prefix = pick(PREFIX, s, 2);
  const suffix = pick(SUFFIX, s, 3);
  const name = `${prefix} ${suffix}`;
  const symbol = (prefix.slice(0, 3) + suffix.slice(0, 2)).toUpperCase();

  const baseMcap = Math.pow(10, 5.3 + 2.4 * r(4)); // 200K .. 50M
  const supply = Math.pow(10, 8 + 1.5 * r(5)); // 100M .. 3B
  const liqRatio = 0.08 + 0.3 * r(6);
  const volRatio = 0.08 + 0.55 * r(7); // 24h volume / mcap
  const eventPeriod = (8 + 22 * r(8)) * 60;
  const ampBase =
    archetype === "pumper" ? 0.3 + 0.7 * r(9)
    : archetype === "steady" ? 0.08 + 0.1 * r(9)
    : archetype === "sleeper" ? 0.02 + 0.03 * r(9)
    : archetype === "dumper" ? -(0.3 + 0.4 * r(9))
    : archetype === "rug" ? 0.4 * r(9)
    : 0.25 * r(9);

  const family = CHAINS[chain].family;
  const spec: MockTokenSpec = {
    chain,
    index,
    address: fakeAddress(s, chain),
    name,
    symbol,
    decimals: family === "evm" ? 18 : r(10) < 0.5 ? 6 : 9,
    dex: pick(DEX_BY_CHAIN[chain], s, 11),
    poolAddress: fakeAddress(s + 1, chain),
    launchMin: EPOCH_MIN + index * launchPeriod(chain),
    archetype,
    supply,
    basePrice: baseMcap / supply,
    baseLiq: baseMcap * liqRatio,
    baseVolPerMin: (baseMcap * volRatio) / DAY,
    avgTradeUsd: 80 + 420 * r(12),
    sigma: 0.004 + 0.012 * r(13),
    eventPeriod,
    eventCenter: r(14) * eventPeriod,
    eventAmp: ampBase,
    eventRise: 40 + 140 * r(15),
    T1: 180 + 420 * r(16),
    T2: 30 + 60 * r(17),
    p1: r(18) * 6.28,
    p2: r(19) * 6.28,
    holders0: Math.round(150 + (baseMcap / 1e6) * 110 + 500 * r(20)),
    holderGrowthPerDay: 0.01 + 0.06 * r(21),
    topHolderPct: (archetype === "rug" || archetype === "trap" ? 18 : 3) + (archetype === "rug" ? 25 : 14) * r(22),
    top10HolderPct: 0,
    mintRevoked: archetype === "rug" || archetype === "trap" ? r(23) < 0.25 : r(23) < 0.93,
    freezeRevoked: archetype === "rug" || archetype === "trap" ? r(24) < 0.4 : r(24) < 0.95,
    verified: r(25) < 0.45,
    rugMin: null,
    pairCount: 1 + Math.floor(r(26) * 4),
  };
  spec.top10HolderPct = Math.min(95, spec.topHolderPct * (2.2 + 1.5 * r(27)));
  if (archetype === "rug") {
    // rugs happen between 2 and 9 days after launch (may be in the future for younger tokens)
    spec.rugMin = spec.launchMin + Math.floor((2 + 7 * r(28)) * DAY);
  }
  specCache.set(cacheKey, spec);
  return spec;
}

// ── time helpers ────────────────────────────────────────────────────────────
export function toMinute(d: Date | number): number {
  return Math.floor((typeof d === "number" ? d : d.getTime()) / 60_000);
}

/** Indices of tokens that are live (launched, not older than the max age) at the given minute. */
export function liveTokenIndices(nowMin: number, chain: ChainId = "solana"): number[] {
  const period = launchPeriod(chain);
  const newest = Math.floor((nowMin - EPOCH_MIN) / period);
  const oldest = Math.ceil((nowMin - MAX_AGE_MIN - EPOCH_MIN) / period);
  const out: number[] = [];
  for (let i = Math.max(0, oldest); i <= newest; i++) out.push(i);
  return out;
}

/** Find a live mock token by address; EVM addresses compare case-insensitively. */
export function findTokenByAddress(address: string, nowMin: number, chain?: ChainId): MockTokenSpec | null {
  const chains = chain ? [chain] : CHAIN_IDS;
  const want = address.toLowerCase();
  for (const c of chains) {
    const evm = CHAINS[c].family === "evm";
    if (evm !== address.startsWith("0x") && !chain) continue;
    for (const i of liveTokenIndices(nowMin, c)) {
      const t = tokenSpec(i, c);
      if (evm ? t.address === want : t.address === address) return t;
    }
  }
  return null;
}

// ── per-minute model ────────────────────────────────────────────────────────
interface Bump {
  /** signed log-price contribution of the recurring event */
  logAmt: number;
  /** 0..1 magnitude used to scale volume/holder activity */
  activity: number;
}

function bump(t: MockTokenSpec, k: number): Bump {
  const age = k - t.launchMin;
  const phase = (((age - t.eventCenter) % t.eventPeriod) + t.eventPeriod) % t.eventPeriod;
  const d = phase > t.eventPeriod / 2 ? phase - t.eventPeriod : phase; // signed distance, minutes
  const w = d < 0 ? t.eventRise : t.eventRise * 2.2;
  const shape = Math.exp(-((d / w) ** 2));
  return { logAmt: t.eventAmp * shape, activity: Math.abs(shape) * Math.min(1, Math.abs(t.eventAmp) * 2) };
}

function rugged(t: MockTokenSpec, k: number): number {
  // 0 before rug, ramps to 1 over 6 minutes after
  if (t.rugMin === null || k < t.rugMin) return 0;
  return Math.min(1, (k - t.rugMin) / 6);
}

export function priceAt(t: MockTokenSpec, k: number): number {
  const age = k - t.launchMin;
  let lp =
    Math.log(t.basePrice) +
    0.08 * Math.sin((2 * Math.PI * k) / t.T1 + t.p1) +
    0.05 * Math.sin((2 * Math.PI * k) / t.T2 + t.p2) +
    bump(t, k).logAmt +
    (t.archetype === "steady" ? 0.015 : t.archetype === "dumper" ? -0.02 : 0) * (age / DAY) +
    gauss(t.index * 31 + 5, k) * t.sigma;
  lp += -3.2 * rugged(t, k);
  return Math.exp(lp);
}

function liquidityAt(t: MockTokenSpec, k: number): number {
  const b = bump(t, k);
  let liq = t.baseLiq * (1 + 0.1 * Math.sin((2 * Math.PI * k) / (t.T1 * 1.3) + t.p2));
  liq *= 1 + 0.35 * Math.max(0, b.logAmt / Math.max(0.05, Math.abs(t.eventAmp))) * Math.min(1, Math.abs(t.eventAmp));
  if (t.archetype === "dumper") liq *= 1 - 0.25 * b.activity;
  liq *= 1 - 0.97 * rugged(t, k);
  return Math.max(50, liq);
}

interface MinuteRec {
  price: number;
  volume: number;
  buys: number;
  sells: number;
}

function minuteRec(t: MockTokenSpec, k: number): MinuteRec {
  const price = priceAt(t, k);
  const prev = priceAt(t, k - 5);
  const b = bump(t, k);
  const rg = rugged(t, k);
  const dlp = Math.log(price / prev);
  const activity = b.activity * (b.logAmt >= 0 ? 1 : 0.7);
  let vol = t.baseVolPerMin * (0.55 + 0.9 * rnd(t.index + 3, k)) * (1 + 5 * activity);
  if (rg > 0) vol = vol * (1 + 6 * (1 - rg)) * (1 - 0.9 * rg) + 0;
  vol = Math.max(0, vol);
  const tx = Math.max(0, Math.round(vol / t.avgTradeUsd + (rnd(t.index + 9, k) < 0.3 ? 1 : 0)));
  let buyFrac = 0.5 + 0.33 * Math.tanh(dlp * 22) + 0.1 * activity * (t.eventAmp >= 0 ? 1 : -1) + 0.1 * (rnd(t.index + 5, k) - 0.5);
  if (t.archetype === "trap") buyFrac = 0.93 + 0.05 * rnd(t.index + 6, k);
  if (rg > 0) buyFrac = 0.5 - 0.35 * rg;
  buyFrac = Math.min(0.97, Math.max(0.05, buyFrac));
  const buys = Math.round(tx * buyFrac);
  return { price, volume: vol, buys, sells: tx - buys };
}

function holdersAt(t: MockTokenSpec, k: number): number {
  const age = Math.max(0, k - t.launchMin) / DAY;
  const b = bump(t, k);
  const grow = 1 + t.holderGrowthPerDay * age;
  const act = 1 + 0.18 * Math.max(0, b.logAmt / Math.max(0.05, Math.abs(t.eventAmp))) * Math.min(1, Math.abs(t.eventAmp));
  const rg = 1 - 0.3 * rugged(t, k);
  return Math.max(1, Math.round(t.holders0 * grow * act * rg));
}

// ── window aggregation ──────────────────────────────────────────────────────
function windowSum(t: MockTokenSpec, endMin: number, minutes: number) {
  let volume = 0;
  let buys = 0;
  let sells = 0;
  const start = Math.max(t.launchMin, endMin - minutes + 1);
  for (let k = start; k <= endMin; k++) {
    const r = minuteRec(t, k);
    volume += r.volume;
    buys += r.buys;
    sells += r.sells;
  }
  return { volume, buys, sells };
}

export function snapshotAt(t: MockTokenSpec, nowMin: number): TokenSnapshot {
  const price = priceAt(t, nowMin);
  const w5 = windowSum(t, nowMin, 5);
  const w15 = windowSum(t, nowMin, 15);
  const w30 = windowSum(t, nowMin, 30);
  const w1h = windowSum(t, nowMin, 60);
  const w24 = windowSum(t, nowMin, DAY);
  const chg = (m: number) => {
    const p0 = priceAt(t, Math.max(t.launchMin, nowMin - m));
    return (price / p0 - 1) * 100;
  };
  return {
    chain: t.chain,
    address: t.address,
    name: t.name,
    symbol: t.symbol,
    decimals: t.decimals,
    dex: t.dex,
    poolAddress: t.poolAddress,
    poolCreatedAt: new Date(t.launchMin * 60_000),
    pairCount: t.pairCount,
    priceUsd: price,
    marketCapUsd: price * t.supply,
    fdvUsd: price * t.supply * 1.0,
    liquidityUsd: liquidityAt(t, nowMin),
    liquidity1hAgoUsd: liquidityAt(t, Math.max(t.launchMin, nowMin - 60)),
    volume5m: w5.volume,
    volume15m: w15.volume,
    volume30m: w30.volume,
    volume1h: w1h.volume,
    volume24h: w24.volume,
    buys5m: w5.buys,
    sells5m: w5.sells,
    buys15m: w15.buys,
    sells15m: w15.sells,
    buys1h: w1h.buys,
    sells1h: w1h.sells,
    change5m: chg(5),
    change1h: chg(60),
    change24h: chg(DAY),
    holders: holdersAt(t, nowMin),
    holders1hAgo: holdersAt(t, Math.max(t.launchMin, nowMin - 60)),
    observedAt: new Date(nowMin * 60_000),
    dataSource: "MOCK",
  };
}

export function onChainAt(t: MockTokenSpec, nowMin: number): OnChainRaw {
  const w = windowSum(t, nowMin, 60);
  const b = bump(t, nowMin);
  const dir = t.eventAmp >= 0 ? 1 : -1;
  const whaleFrac = 0.18 + 0.15 * rnd(t.index + 40, Math.floor(nowMin / 30));
  const totalUsd = w.volume;
  const buyShare = w.buys / Math.max(1, w.buys + w.sells);
  const bias = 0.5 + (buyShare - 0.5) * 0.9 + 0.1 * b.activity * dir;
  const largeBuyUsd = totalUsd * whaleFrac * bias;
  const largeSellUsd = totalUsd * whaleFrac * (1 - bias);
  const rg = rugged(t, nowMin);
  const liqNow = liquidityAt(t, nowMin);
  const liqPrev = liquidityAt(t, nowMin - 60);
  const delta = liqNow - liqPrev;
  const holders = holdersAt(t, nowMin);
  const holdersPrev = holdersAt(t, nowMin - 60);
  return {
    mintAuthorityRevoked: t.mintRevoked,
    freezeAuthorityRevoked: t.freezeRevoked,
    verified: t.verified,
    topHolderPct: t.topHolderPct,
    top10HolderPct: t.top10HolderPct,
    sellSimulationOk: t.archetype !== "trap" && rg < 0.5,
    metadataAnomalies: t.archetype === "trap" && rnd(t.index, 77) < 0.5 ? ["Token metadata URI is unreachable"] : [],
    largeBuys1h: Math.round(largeBuyUsd / (t.avgTradeUsd * 6)),
    largeSells1h: Math.round(largeSellUsd / (t.avgTradeUsd * 6)),
    largeBuyUsd1h: largeBuyUsd,
    largeSellUsd1h: largeSellUsd,
    newHolders1h: Math.max(0, holders - holdersPrev),
    liquidityAddedUsd1h: Math.max(0, delta),
    liquidityRemovedUsd1h: Math.max(0, -delta),
    suspiciousTxRatio: t.archetype === "trap" ? 0.45 : t.archetype === "rug" ? 0.25 : 0.03 + 0.05 * rnd(t.index, 78),
    poolActive: rg < 0.98,
    // what verification services would say about this synthetic token, so the mock market exercises every trust tier
    trust: {
      sources: ["mock"],
      listed: t.verified,
      organicScore: t.archetype === "trap" ? 5 : 70,
      honeypot: t.archetype === "trap" || rg >= 0.5,
      sellSimulated: true,
      buyTaxPct: 0,
      sellTaxPct: 0,
      openSource: true,
      mintable: !t.mintRevoked,
      upgradeableProxy: false,
      hiddenOwner: false,
      canReclaimOwnership: false,
      pausable: false,
      blacklist: false,
      lpLockedPct: t.archetype === "rug" ? 0 : 95,
      holders,
      creatorPct: 1,
      rugged: rg >= 0.98,
      covered: true,
      dangers: [],
      cautions: [],
    },
  };
}

// ── candles ─────────────────────────────────────────────────────────────────
export function candlesAt(t: MockTokenSpec, nowMin: number, tf: Timeframe, limit: number): Candle[] {
  const step = TIMEFRAME_MINUTES[tf];
  const lastBucketStart = Math.floor(nowMin / step) * step;
  const out: Candle[] = [];
  for (let i = limit - 1; i >= 0; i--) {
    const start = lastBucketStart - i * step;
    if (start + step - 1 < t.launchMin) continue;
    const end = Math.min(nowMin, start + step - 1);
    const from = Math.max(start, t.launchMin);
    let open = priceAt(t, from - 1 < t.launchMin ? from : from - 1);
    const first = open;
    let high = -Infinity;
    let low = Infinity;
    let close = first;
    let volume = 0;
    let buys = 0;
    let sells = 0;
    for (let k = from; k <= end; k++) {
      const r = minuteRec(t, k);
      close = r.price;
      const wick = 1 + Math.abs(gauss(t.index + 2, k)) * t.sigma * 0.5;
      high = Math.max(high, r.price * wick, open);
      low = Math.min(low, r.price / wick);
      volume += r.volume;
      buys += r.buys;
      sells += r.sells;
    }
    open = first;
    high = Math.max(high, open, close);
    low = Math.min(low, open, close);
    out.push({ time: start * 60, open, high, low, close, volume, buys, sells });
  }
  return out;
}

/** Per-hour holder / liquidity history for charts. */
export function historySeries(t: MockTokenSpec, nowMin: number, points: number, stepMin: number) {
  const out: { time: number; holders: number; liquidityUsd: number; volume: number }[] = [];
  for (let i = points - 1; i >= 0; i--) {
    const k = nowMin - i * stepMin;
    if (k < t.launchMin) continue;
    out.push({
      time: k * 60,
      holders: holdersAt(t, k),
      liquidityUsd: liquidityAt(t, k),
      volume: windowSum(t, k, stepMin).volume,
    });
  }
  return out;
}
