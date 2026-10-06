/**
 * Independent verification of a token, from services that have nothing to gain from us buying it. None needs an API key.
 *
 *   Solana  Jupiter's token API (is it on the verified list, how organic is the trading, how much the dev holds) and
 *           RugCheck (rug/danger flags, how much liquidity is locked or burned, the creator's holding).
 *   EVM     GoPlus (honeypot, taxes, contract powers, source verified, LP locks, trusted list) and honeypot.is (an actual
 *           simulated buy-then-sell with the real taxes).
 *
 * Each service answers with what it knows and nothing more: a field it can't speak to stays null, and the trust tiers
 * (analysis/trust.ts) never read null as "fine". Shapes below were captured from the live APIs.
 */
import { CHAINS } from "../chains";
import type { ChainId, TrustFacts } from "../types";
import { getJson } from "./http";

const emptyFacts = (): TrustFacts => ({
  sources: [],
  listed: null,
  organicScore: null,
  honeypot: null,
  sellSimulated: null,
  buyTaxPct: null,
  sellTaxPct: null,
  openSource: null,
  mintable: null,
  upgradeableProxy: null,
  hiddenOwner: null,
  canReclaimOwnership: null,
  pausable: null,
  blacklist: null,
  lpLockedPct: null,
  holders: null,
  creatorPct: null,
  rugged: null,
  covered: null,
  dangers: [],
  cautions: [],
});

const num = (v: unknown): number | null => {
  // an empty string is how GoPlus says "I could not work this out": it is unknown, not zero
  if (typeof v === "string" && v.trim() === "") return null;
  const n = typeof v === "string" ? Number(v) : typeof v === "number" ? v : NaN;
  return Number.isFinite(n) ? n : null;
};
/** GoPlus encodes booleans as "0"/"1" strings, and leaves a field out when it can't tell. */
const flag = (v: unknown): boolean | null => (v === "1" || v === 1 || v === true ? true : v === "0" || v === 0 || v === false ? false : null);

// ---- parsers (pure) -------------------------------------------------------------------------------------------------

interface JupToken {
  id: string;
  isVerified?: boolean | null;
  tags?: string[];
  organicScore?: number;
  holderCount?: number;
  audit?: { devBalancePercentage?: number | null };
}

/** Jupiter token search (lite-api.jup.ag/tokens/v2/search?query=<mint>): an array; ours is the entry whose id is the mint. */
export function parseJupiter(json: unknown, mint: string): Partial<TrustFacts> | null {
  const t = (Array.isArray(json) ? (json as JupToken[]) : []).find((x) => x?.id === mint);
  if (!t) return null;
  const tags = t.tags ?? [];
  // "community" only means holders voted for it; "verified"/"strict" is Jupiter's own curation
  const listed = t.isVerified === true || tags.includes("verified") || tags.includes("strict");
  return {
    listed,
    organicScore: num(t.organicScore),
    holders: num(t.holderCount),
    creatorPct: num(t.audit?.devBalancePercentage),
  };
}

interface RcRisk { name?: string; level?: string; description?: string }
interface RcMarket { lp?: { lpLockedUSD?: number; quoteUSD?: number; baseUSD?: number } }
interface RugCheckReport {
  rugged?: boolean;
  risks?: RcRisk[] | null;
  markets?: RcMarket[] | null;
  totalHolders?: number;
  creatorBalance?: number;
  token?: { supply?: number };
  transferFee?: { pct?: number };
}

/** RugCheck full report (api.rugcheck.xyz/v1/tokens/<mint>/report). */
export function parseRugCheck(json: unknown): Partial<TrustFacts> | null {
  const r = json as RugCheckReport | null;
  if (!r || typeof r !== "object" || (r.rugged === undefined && !r.risks && !r.markets)) return null;
  const risks = r.risks ?? [];
  const nameOf = (x: RcRisk) => x.name ?? x.description ?? "unnamed flag";
  // RugCheck rates some things "danger" that our own checks already judge better, in context, or that describe every pool
  // (measured live on BONK, WIF and JUP: a pool vault is always the "single holder", concentrated-liquidity pools can't be
  // locked). Those are kept as cautions; a copycat, which RugCheck only rates "warn", is a real scam tell, so it is a danger.
  const NOISE = /single holder|top 10|holder ownership|high ownership|unlocked|lp provider|low amount|low liquidity|market cap per holder|mutable/i;
  const COPYCAT = /copycat/i;
  const named = (level: "danger" | "warn") =>
    risks
      .filter((x) => {
        const copycat = COPYCAT.test(nameOf(x));
        if (level === "danger") return (x.level === "danger" && !NOISE.test(nameOf(x))) || copycat;
        return !copycat && (x.level === "warn" || (x.level === "danger" && NOISE.test(nameOf(x))));
      })
      .map(nameOf);
  // liquidity locked or burned, weighted by how much each pool holds (a locked sliver beside a big open pool is not "locked")
  let locked = 0;
  let total = 0;
  for (const m of r.markets ?? []) {
    const lp = m.lp;
    if (!lp) continue;
    const size = (lp.quoteUSD ?? 0) + (lp.baseUSD ?? 0);
    if (!(size > 0)) continue;
    total += size;
    locked += Math.min(size, Math.max(0, lp.lpLockedUSD ?? 0));
  }
  const supply = r.token?.supply ?? 0;
  const creatorPct = supply > 0 && typeof r.creatorBalance === "number" ? (r.creatorBalance / supply) * 100 : null;
  const dangers = named("danger");
  if ((r.transferFee?.pct ?? 0) > 0) dangers.push(`Token charges a ${r.transferFee!.pct}% transfer fee`);
  return {
    rugged: typeof r.rugged === "boolean" ? r.rugged : null,
    lpLockedPct: total > 0 ? (locked / total) * 100 : null,
    holders: num(r.totalHolders),
    creatorPct,
    dangers,
    cautions: named("warn"),
  };
}

interface GoPlusRow {
  is_honeypot?: string;
  honeypot_with_same_creator?: string;
  cannot_buy?: string;
  cannot_sell_all?: string;
  buy_tax?: string;
  sell_tax?: string;
  is_open_source?: string;
  is_proxy?: string;
  is_mintable?: string;
  hidden_owner?: string;
  can_take_back_ownership?: string;
  transfer_pausable?: string;
  is_blacklisted?: string;
  owner_change_balance?: string;
  selfdestruct?: string;
  slippage_modifiable?: string;
  personal_slippage_modifiable?: string;
  trading_cooldown?: string;
  is_anti_whale?: string;
  holder_count?: string;
  creator_percent?: string;
  trust_list?: string;
  is_in_dex?: string;
  lp_holders?: { address?: string; percent?: string; is_locked?: number | string }[] | null;
}

/** the zero address and the 0x...dead address: LP tokens sent here can never be redeemed */
const BURN = /^0x0*(dead)?$/i;

/** GoPlus token_security (api.gopluslabs.io/api/v1/token_security/<chainId>?contract_addresses=<a>): result keyed by address. */
export function parseGoPlus(json: unknown, address: string): Partial<TrustFacts> | null {
  const result = (json as { result?: Record<string, GoPlusRow> | null } | null)?.result;
  const row = result?.[address.toLowerCase()] ?? (result ? Object.values(result)[0] : undefined);
  if (!row || typeof row !== "object") return null;
  const dangers: string[] = [];
  const cautions: string[] = [];
  if (flag(row.honeypot_with_same_creator)) dangers.push("The creator has launched honeypots before");
  if (flag(row.cannot_buy)) dangers.push("The token can't be bought");
  if (flag(row.cannot_sell_all)) dangers.push("Holders can't sell their whole balance");
  if (flag(row.owner_change_balance)) dangers.push("The owner can change holders' balances");
  if (flag(row.selfdestruct)) dangers.push("The contract can destroy itself");
  if (flag(row.slippage_modifiable) || flag(row.personal_slippage_modifiable)) dangers.push("The owner can change the trading tax at will");
  if (flag(row.trading_cooldown)) cautions.push("Trading has a cooldown between trades");
  if (flag(row.is_anti_whale)) cautions.push("Limits how much one wallet can trade");

  // liquidity locked or burned: the share of LP tokens that are locked in a locker contract or sent to a burn address
  let lockedPct: number | null = null;
  if (Array.isArray(row.lp_holders) && row.lp_holders.length) {
    lockedPct = row.lp_holders.reduce((sum, h) => sum + (flag(h.is_locked) || BURN.test(h.address ?? "") ? (num(h.percent) ?? 0) : 0), 0) * 100;
    lockedPct = Math.min(100, lockedPct);
  }
  const taxFraction = (v: unknown) => {
    const n = num(v);
    return n === null ? null : n * 100; // GoPlus gives tax as a fraction (0.05 = 5%)
  };
  const creator = num(row.creator_percent);
  return {
    // a token whose holders can't sell their whole balance is a honeypot by another name
    honeypot: flag(row.is_honeypot) === true || flag(row.cannot_sell_all) === true ? true : flag(row.is_honeypot),
    // GoPlus runs its own buy-and-sell test on tokens that trade in a pool; it has done so when the token is in a pool and it
    // came back with a real sell tax. That is a sell test on every chain GoPlus covers, not only the three honeypot.is simulates.
    sellSimulated: flag(row.is_in_dex) === true && flag(row.is_honeypot) !== null && taxFraction(row.sell_tax) !== null ? true : null,
    buyTaxPct: taxFraction(row.buy_tax),
    sellTaxPct: taxFraction(row.sell_tax),
    openSource: flag(row.is_open_source),
    mintable: flag(row.is_mintable),
    upgradeableProxy: flag(row.is_proxy),
    hiddenOwner: flag(row.hidden_owner),
    canReclaimOwnership: flag(row.can_take_back_ownership),
    pausable: flag(row.transfer_pausable),
    blacklist: flag(row.is_blacklisted),
    lpLockedPct: lockedPct,
    holders: num(row.holder_count),
    creatorPct: creator === null ? null : creator * 100,
    listed: flag(row.trust_list) === true ? true : null,
    dangers,
    cautions,
  };
}

interface HoneypotIs {
  simulationSuccess?: boolean;
  honeypotResult?: { isHoneypot?: boolean; honeypotReason?: string };
  simulationResult?: { buyTax?: number; sellTax?: number };
}

/** honeypot.is IsHoneypot (api.honeypot.is/v2/IsHoneypot?address=&chainID=): a real simulated buy and sell. */
export function parseHoneypotIs(json: unknown): Partial<TrustFacts> | null {
  const r = json as HoneypotIs | null;
  if (!r || typeof r !== "object" || r.honeypotResult === undefined) return null;
  const simulated = r.simulationSuccess === true;
  const dangers: string[] = [];
  if (r.honeypotResult.isHoneypot) dangers.push(r.honeypotResult.honeypotReason ? `Honeypot: ${r.honeypotResult.honeypotReason}` : "Honeypot: a simulated sell failed");
  return {
    honeypot: r.honeypotResult.isHoneypot === true ? true : simulated ? false : null,
    sellSimulated: simulated,
    // only trust the taxes when the simulation actually ran
    buyTaxPct: simulated ? num(r.simulationResult?.buyTax) : null,
    sellTaxPct: simulated ? num(r.simulationResult?.sellTax) : null,
    dangers,
  };
}

/** Combine what several services said. A definite answer beats "unknown"; for risk flags the worst answer wins. */
export function mergeTrustFacts(parts: { source: string; facts: Partial<TrustFacts> | null }[]): TrustFacts {
  const out = emptyFacts();
  for (const { source, facts } of parts) {
    if (!facts) continue;
    out.sources.push(source);
    for (const [k, v] of Object.entries(facts) as [keyof TrustFacts, unknown][]) {
      if (v === null || v === undefined || k === "sources") continue;
      if (k === "dangers" || k === "cautions") {
        for (const s of v as string[]) if (!out[k].includes(s)) out[k].push(s);
      } else if (k === "honeypot" || k === "rugged" || k === "mintable" || k === "hiddenOwner" || k === "canReclaimOwnership" || k === "upgradeableProxy" || k === "pausable" || k === "blacklist") {
        // any service reporting the problem is enough
        (out as unknown as Record<string, unknown>)[k] = out[k] === true || v === true ? true : v;
      } else if (k === "listed") {
        out.listed = out.listed === true || v === true;
      } else if (k === "covered") {
        out.covered = out.covered === true || v === true ? true : (v as boolean);
      } else if (k === "lpLockedPct" || k === "buyTaxPct" || k === "sellTaxPct" || k === "creatorPct") {
        // the more worrying figure wins: least locked, highest tax, biggest creator holding
        const cur = out[k];
        (out as unknown as Record<string, unknown>)[k] = cur === null ? v : k === "lpLockedPct" ? Math.min(cur, v as number) : Math.max(cur, v as number);
      } else if (out[k] === null || out[k] === undefined) {
        (out as unknown as Record<string, unknown>)[k] = v;
      }
    }
  }
  return out;
}

// ---- fetching -------------------------------------------------------------------------------------------------------

const OK_TTL_MS = 15 * 60_000;
const MISS_TTL_MS = 90_000;
const cache = new Map<string, { at: number; ttl: number; facts: TrustFacts }>();
const inflight = new Map<string, Promise<TrustFacts>>();
/** A service that rate-limits or errors is left alone for a while rather than hammered by every token in the batch. */
const backoffUntil: Record<string, number> = {};
const BACKOFF_MS = 2 * 60_000;

async function ask(source: string, url: string, parse: (j: unknown) => Partial<TrustFacts> | null, timeoutMs: number) {
  if (Date.now() < (backoffUntil[source] ?? 0)) return { source, facts: null };
  try {
    return { source, facts: parse(await getJson<unknown>(url, undefined, timeoutMs)) };
  } catch (err) {
    // a 429 means slow down; a timeout often means the service is still computing a brand-new token, so retry soon, not never
    if (err instanceof Error && /HTTP 429/.test(err.message)) backoffUntil[source] = Date.now() + BACKOFF_MS;
    return { source, facts: null };
  }
}

/**
 * The chains GoPlus covers, read from GoPlus itself (not a list kept here, which would go stale as chains are added). Cached for
 * hours. null = couldn't be read, in which case nothing is assumed either way.
 */
let supportedCache: { at: number; ids: Set<string> } | null = null;
async function goplusChains(): Promise<Set<string> | null> {
  if (supportedCache && Date.now() - supportedCache.at < 6 * 3_600_000) return supportedCache.ids;
  try {
    const j = await getJson<{ result?: { id: string | number }[] }>("https://api.gopluslabs.io/api/v1/supported_chains", undefined, 5_000);
    const ids = new Set((j.result ?? []).map((c) => String(c.id)));
    if (ids.size) supportedCache = { at: Date.now(), ids };
    return ids.size ? ids : (supportedCache?.ids ?? null);
  } catch {
    return supportedCache?.ids ?? null;
  }
}

async function fetchFresh(chain: ChainId, address: string): Promise<TrustFacts> {
  const meta = CHAINS[chain];
  if (meta.family === "evm") {
    const id = meta.evmChainId;
    if (!id) return emptyFacts();
    const goplusCovers = (await goplusChains())?.has(String(id)) ?? null;
    const [goplus, honeypotIs] = await Promise.all([
      // a chain GoPlus doesn't list isn't asked: it would only answer "unsupported"
      goplusCovers === false ? Promise.resolve({ source: "goplus", facts: null }) : ask("goplus", `https://api.gopluslabs.io/api/v1/token_security/${id}?contract_addresses=${address}`, (j) => parseGoPlus(j, address), 5_000),
      ask("honeypot.is", `https://api.honeypot.is/v2/IsHoneypot?address=${address}&chainID=${id}`, parseHoneypotIs, 6_000),
    ]);
    const facts = mergeTrustFacts([goplus, honeypotIs]);
    // Nobody to ask on this chain is different from a service that is down: the first is permanent and says so.
    facts.covered = facts.sources.length ? true : goplusCovers === false ? false : null;
    return facts;
  }
  const [jupiter, rugcheck] = await Promise.all([
    ask("jupiter", `https://lite-api.jup.ag/tokens/v2/search?query=${address}`, (j) => parseJupiter(j, address), 5_000),
    // RugCheck computes a new token's report on demand, which can take several seconds the first time and is instant after
    ask("rugcheck", `https://api.rugcheck.xyz/v1/tokens/${address}/report`, parseRugCheck, 9_000),
  ]);
  const facts = mergeTrustFacts([jupiter, rugcheck]);
  facts.covered = facts.sources.length ? true : null;
  return facts;
}

/** Never throws: when nothing can be reached the result simply has no sources, and the token stays unproven. */
export async function fetchTrustFacts(chain: ChainId, address: string): Promise<TrustFacts> {
  const key = `${chain}:${address.toLowerCase()}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < hit.ttl) return hit.facts;
  const pending = inflight.get(key);
  if (pending) return pending;
  const p = fetchFresh(chain, address)
    .catch(() => emptyFacts())
    .then((facts) => {
      // once the main service for this chain family has answered the result is kept a good while; otherwise it is asked again soon
      const main = CHAINS[chain].family === "evm" ? "goplus" : "rugcheck";
      if (cache.size > 2000) cache.clear();
      cache.set(key, { at: Date.now(), ttl: facts.sources.includes(main) || facts.covered === false ? OK_TTL_MS : MISS_TTL_MS, facts });
      return facts;
    })
    .finally(() => inflight.delete(key));
  inflight.set(key, p);
  return p;
}

/** For tests. */
export function resetTrustCache() {
  supportedCache = null;
  cache.clear();
  inflight.clear();
  for (const k of Object.keys(backoffUntil)) delete backoffUntil[k];
}
