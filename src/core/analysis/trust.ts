import { CHAINS } from "../chains";
import type { OnChainRaw, TokenSnapshot, TrustCheck, TrustFacts, TrustReport, TrustTier } from "../types";
import { TRUST_RANK } from "../types";

/**
 * How far a token has earned trust. This is not a safety guarantee: it is "independent services checked this token and
 * found nothing wrong, and it has the depth and history that scams rarely bother to build". Every bar is here, in one place.
 *
 * The tiers, worst to best:
 *   DANGEROUS  a honeypot, a confirmed rug, or a tax that takes the proceeds. Never buy (blocked).
 *   RISKY      a named red flag: powers that let the creator hurt holders, or liquidity that can be pulled.
 *   UNPROVEN   no red flag found, but the token hasn't earned trust yet: too young, too thin, or the checks couldn't be run.
 *   TRUSTED    cleared every check below, with real liquidity, volume, holders, and some history.
 *   VERIFIED   TRUSTED, and also on a curated list that someone else maintains (Jupiter's verified list, GoPlus's trusted list).
 *
 * "Couldn't check" never counts as a pass: it holds a token at UNPROVEN until the check can be run.
 */
export const TRUST_BAR = {
  /** a pool this deep can't be emptied by one wallet in a hurry, and a $10-$100 buy barely moves it */
  minLiquidityUsd: 50_000,
  minVolume24hUsd: 20_000,
  /** most rug pulls happen in the first day */
  minAgeHours: 24,
  /** only judged when the holder count is known */
  minHolders: 100,
  /** at or above this much of the liquidity locked or burned, it can't be pulled */
  lpLockedOkPct: 70,
  /** below this much locked, the pool can be pulled at will */
  lpLockedBadPct: 50,
  /**
   * A pool this deep AND this old is not the kind that gets pulled in one go, and many established pools can't be locked at all
   * (concentrated-liquidity positions on Orca, Raydium CLMM, Uniswap v3: measured live, BONK, WIF and JUP read 14%, 48% and 1%
   * "locked"). An unlocked LP is tolerated for those.
   */
  deepPoolUsd: 250_000,
  establishedHours: 7 * 24,
  /** a tax at or above this is a scam in itself; between the two it is a red flag */
  taxDangerPct: 15,
  taxRiskPct: 5,
  /** the creator holding this much of the supply can dump on everyone */
  creatorRiskPct: 20,
  creatorCautionPct: 10,
  /** Jupiter's organic score: below this, most of the trading looks like bots */
  minOrganicScore: 30,
} as const;

type Kind = "danger" | "risk" | "earn" | "essential" | "info";
interface Row extends TrustCheck {
  kind: Kind;
}

const usd = (n: number) => `$${Math.round(n).toLocaleString("en-US")}`;
const pct = (n: number, d = 1) => `${n.toFixed(d).replace(/\.0+$/, "")}%`;

export function assessTrust(snap: TokenSnapshot, raw: OnChainRaw, now = new Date()): TrustReport {
  const f: TrustFacts | null = raw.trust ?? null;
  const evm = CHAINS[snap.chain]?.family === "evm";
  const sources = f?.sources ?? [];
  const listed = f?.listed === true;
  const rows: Row[] = [];
  const add = (kind: Kind, id: string, label: string, status: TrustCheck["status"], detail: string) => rows.push({ kind, id, label, status, detail });

  // ---- was anyone able to check this token at all?
  add("essential", "sources", "Independent checks ran", sources.length ? "pass" : "unknown", sources.length ? `Checked by ${sources.join(", ")}` : "No verification service could be reached, so nothing here has been confirmed");

  // ---- can it be sold / is it a honeypot
  const honeypot = f?.honeypot === true || raw.sellSimulationOk === false;
  if (honeypot) add("danger", "honeypot", "Can be sold", "fail", "Honeypot: selling this token fails or is blocked");
  else if (evm) {
    if (f?.honeypot === false && f.sellSimulated) add("essential", "honeypot", "Can be sold", "pass", "A real sell was simulated and went through");
    else add("essential", "honeypot", "Can be sold", "unknown", "No real sell simulation could be run for this token");
  } else if (raw.dataAvailable === false) {
    add("essential", "honeypot", "Can be sold", "unknown", "The token's authorities couldn't be read just now");
  } else if (raw.freezeAuthorityRevoked) {
    add("essential", "honeypot", "Can be sold", "pass", "Nobody can freeze holders' accounts. The swap is dry-run again before your wallet opens");
  } else {
    // counted once, under "Creator can't change the rules" below
    add("info", "honeypot", "Can be sold", "fail", "The creator can freeze token accounts, which stops holders selling");
  }

  // ---- taxes (EVM tokens can take a cut of every trade)
  if (evm) {
    const buy = f?.buyTaxPct ?? null;
    const sell = f?.sellTaxPct ?? null;
    if (buy === null && sell === null) add("essential", "tax", "No trading tax", "unknown", "Buy and sell tax unknown");
    else {
      const worst = Math.max(buy ?? 0, sell ?? 0);
      const text = `Buy tax ${pct(buy ?? 0)}, sell tax ${pct(sell ?? 0)}`;
      if (worst >= TRUST_BAR.taxDangerPct) add("danger", "tax", "No trading tax", "fail", `${text}: the tax takes most of what you'd get back`);
      else if (worst >= TRUST_BAR.taxRiskPct) add("risk", "tax", "No trading tax", "fail", `${text}: a high tax eats into every trade`);
      else add("essential", "tax", "No trading tax", "pass", text);
    }
  }

  // ---- already rugged
  if (f?.rugged === true) add("danger", "rugged", "Not rugged", "fail", "The checking service reports this token as rugged");
  else add("info", "rugged", "Not rugged", f?.rugged === false ? "pass" : "unknown", f?.rugged === false ? "No rug pull detected" : "Unknown");

  // ---- powers the creator keeps
  if (evm) {
    // A hidden owner or a way to take ownership back is a scam tell on any token. The ordinary admin powers (mint, proxy,
    // pause, blacklist) are how established tokens like CAKE or USDC are built, so on a curated list they are noted, not failed.
    const backdoors: string[] = [];
    if (f?.hiddenOwner) backdoors.push("has a hidden owner");
    if (f?.canReclaimOwnership) backdoors.push("can take back ownership");
    const admin: string[] = [];
    if (f?.mintable) admin.push("can mint more tokens");
    if (f?.upgradeableProxy) admin.push("its code can be swapped out (proxy)");
    // pausing or blacklisting only matters while someone still holds the keys
    if ((f?.pausable || f?.blacklist) && !raw.mintAuthorityRevoked) admin.push(`can ${f?.pausable ? "pause trading" : "blacklist wallets"}`);
    const powers = [...backdoors, ...(listed ? [] : admin)];
    if (powers.length) add("risk", "powers", "Creator can't change the rules", "fail", `The creator ${powers.join(", ")}`);
    else if (f && f.mintable !== null) add("essential", "powers", "Creator can't change the rules", "pass", admin.length ? `The creator ${admin.join(", ")}, which is normal for a token on a curated list` : "No mint, hidden-owner, proxy or pause powers found");
    else add("essential", "powers", "Creator can't change the rules", "unknown", "The contract's powers couldn't be read");
    if (f?.openSource === false && !listed) add("risk", "source", "Contract source published", "fail", "The contract's code isn't published, so nobody can read what it does");
    else if (f?.openSource === true) add("essential", "source", "Contract source published", "pass", "Source code is verified on the block explorer");
    else if (listed) add("essential", "source", "Contract source published", "pass", "Not confirmed, but the token is on a curated list");
    else add("essential", "source", "Contract source published", "unknown", "Whether the source code is published couldn't be checked");
  } else if (raw.dataAvailable === false) {
    add("essential", "powers", "Creator can't change the rules", "unknown", "The token's authorities couldn't be read just now");
  } else {
    const live: string[] = [];
    if (!raw.mintAuthorityRevoked) live.push("mint authority is still active (supply can be inflated)");
    if (!raw.freezeAuthorityRevoked) live.push("freeze authority is still active");
    if (live.length) add("risk", "powers", "Creator can't change the rules", "fail", `The ${live.join(" and the ")}`);
    else add("essential", "powers", "Creator can't change the rules", "pass", "Mint and freeze authority are both revoked");
  }

  // ---- named dangers from the checking services
  if (f?.dangers.length) add("risk", "flags", "No danger flags", "fail", f.dangers.slice(0, 3).join("; "));
  else add("info", "flags", "No danger flags", sources.length ? "pass" : "unknown", sources.length ? (f?.cautions.length ? `Nothing serious. Cautions: ${f.cautions.slice(0, 2).join("; ")}` : "Nothing flagged") : "Unknown");

  // ---- is the liquidity locked
  const locked = f?.lpLockedPct ?? null;
  const ageH = (now.getTime() - new Date(snap.poolCreatedAt).getTime()) / 3_600_000;
  const settled = snap.liquidityUsd >= TRUST_BAR.deepPoolUsd && ageH >= TRUST_BAR.establishedHours;
  if (locked !== null && locked >= TRUST_BAR.lpLockedOkPct) add("essential", "lock", "Liquidity locked", "pass", `${pct(locked, 0)} of the liquidity is locked or burned, so it can't be pulled`);
  else if (settled) add("essential", "lock", "Liquidity locked", "pass", `${locked === null ? "Not confirmed locked" : `${pct(locked, 0)} locked`}, but the pool is deep (${usd(snap.liquidityUsd)}) and has traded for ${Math.round(ageH / 24)} days`);
  else if (listed) add("essential", "lock", "Liquidity locked", "pass", `${locked === null ? "Not confirmed locked" : `${pct(locked, 0)} locked`}, but the token is on a curated list`);
  else if (locked === null) add("essential", "lock", "Liquidity locked", "unknown", "Whether the liquidity is locked couldn't be checked");
  else if (locked < TRUST_BAR.lpLockedBadPct) add("risk", "lock", "Liquidity locked", "fail", `Only ${pct(locked, 0)} of the liquidity is locked: the creator can pull it`);
  else add("earn", "lock", "Liquidity locked", "fail", `Only ${pct(locked, 0)} of the liquidity is locked`);

  // ---- the creator's own holding
  const creator = f?.creatorPct ?? null;
  if (creator !== null && creator >= TRUST_BAR.creatorRiskPct) add("risk", "creator", "Creator holds little", "fail", `The creator wallet holds ${pct(creator)} of the supply and could dump it`);
  else if (creator !== null) add("info", "creator", "Creator holds little", "pass", `Creator wallet holds ${pct(creator)}${creator >= TRUST_BAR.creatorCautionPct ? " (a lot)" : ""}`);

  // ---- depth, activity, history: what scams rarely build
  const liqOk = snap.liquidityUsd >= TRUST_BAR.minLiquidityUsd;
  add("earn", "liquidity", "Real liquidity", liqOk ? "pass" : "fail", liqOk ? `${usd(snap.liquidityUsd)} in the pool` : `${usd(snap.liquidityUsd)} in the pool, trust needs ${usd(TRUST_BAR.minLiquidityUsd)}`);
  const volOk = snap.volume24h >= TRUST_BAR.minVolume24hUsd;
  add("earn", "volume", "Real trading volume", volOk ? "pass" : "fail", volOk ? `${usd(snap.volume24h)} traded in 24h` : `${usd(snap.volume24h)} traded in 24h, trust needs ${usd(TRUST_BAR.minVolume24hUsd)}`);
  const ageOk = ageH >= TRUST_BAR.minAgeHours;
  const ageText = ageH < 48 ? `${Math.max(0, Math.round(ageH))}h` : `${Math.round(ageH / 24)}d`;
  // a curated list has already vouched for its tokens' history
  add("earn", "age", "Some history", ageOk || listed ? "pass" : "fail", ageOk ? `Trading for ${ageText}` : listed ? `Only ${ageText} old, but on a curated list` : `Only ${ageText} old, trust needs ${TRUST_BAR.minAgeHours}h`);
  const holders = f?.holders ?? (snap.holders >= 0 ? snap.holders : null);
  if (holders !== null) {
    const hOk = holders >= TRUST_BAR.minHolders;
    add("earn", "holders", "Spread across holders", hOk || listed ? "pass" : "fail", `${holders.toLocaleString("en-US")} holders${hOk ? "" : `, trust needs ${TRUST_BAR.minHolders}`}`);
  } else add("info", "holders", "Spread across holders", "unknown", "Holder count unknown");
  const organic = f?.organicScore ?? null;
  if (organic !== null) {
    const oOk = organic >= TRUST_BAR.minOrganicScore;
    add("earn", "organic", "Traded by real people", oOk ? "pass" : "fail", oOk ? `Organic score ${Math.round(organic)}/100` : `Organic score ${Math.round(organic)}/100: most of the trading looks automated`);
  }

  // ---- on a list someone else curates
  add("info", "listed", "On a curated list", listed ? "pass" : "unknown", listed ? (evm ? "On GoPlus's trusted token list" : "On Jupiter's verified list") : "Not on a curated list (most new tokens aren't)");

  const failed = (k: Kind) => rows.filter((r) => r.kind === k && r.status === "fail");
  const dangers = failed("danger");
  const risks = failed("risk");
  const earns = failed("earn");
  const unknowns = rows.filter((r) => r.kind === "essential" && r.status === "unknown");
  const strip = ({ kind: _k, ...c }: Row): TrustCheck => c;
  const checks = rows.map(strip);

  let tier: TrustTier;
  let summary: string;
  const missing: string[] = [];
  if (dangers.length) {
    tier = "DANGEROUS";
    summary = `Do not buy. ${dangers.map((d) => d.detail).join(". ")}.`;
  } else if (risks.length) {
    tier = "RISKY";
    summary = `Red flags: ${risks.map((r) => r.detail.replace(/\.$/, "")).join("; ")}.`;
  } else if (earns.length || unknowns.length) {
    tier = "UNPROVEN";
    missing.push(...earns.map((e) => e.detail), ...unknowns.map((u) => u.detail));
    summary = `No red flags found, but this token hasn't earned trust yet: ${missing.slice(0, 3).join("; ")}.`;
  } else if (listed) {
    tier = "VERIFIED";
    summary = `${evm ? "On GoPlus's trusted list" : "On Jupiter's verified list"} and passed every check, with ${usd(snap.liquidityUsd)} of liquidity.`;
  } else {
    tier = "TRUSTED";
    summary = `Passed every check with ${usd(snap.liquidityUsd)} of liquidity and ${ageText} of history. Not on a curated list. This is not a guarantee.`;
    missing.push("Be added to a curated verified list");
  }
  return { tier, summary, checks, missing, sources };
}

export const meetsTrust = (tier: TrustTier | null | undefined, min: TrustTier) => (tier ? TRUST_RANK[tier] >= TRUST_RANK[min] : false);
