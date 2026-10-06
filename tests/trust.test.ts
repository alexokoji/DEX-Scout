/**
 * "Add a system to verify token authenticity so users don't end up buying scam tokens." Tokens now have to earn trust from
 * independent checks plus real depth and history. The parser fixtures below are shaped from live responses of each service
 * (captured while building this); the tier tests pin what each kind of token earns.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("next/headers", () => ({ cookies: async () => ({ get: () => undefined, set: () => {}, delete: () => {} }) }));
vi.mock("@/lib/env", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/env")>()), liveTradingAllowed: () => true }));

import { assessSafety } from "@/core/analysis/safety";
import { assessTrust, TRUST_BAR } from "@/core/analysis/trust";
import { fetchTrustFacts, mergeTrustFacts, parseGoPlus, parseHoneypotIs, parseJupiter, parseRugCheck, resetTrustCache } from "@/core/providers/trust";
import { generateSignal } from "@/core/signals/engine";
import { entryWarnings, validateEntry } from "@/core/trading/validation";
import type { OnChainRaw, TrustFacts } from "@/core/types";
import { quoteFromImpact } from "@/core/trading/quoteMath";
import { buildAnalysis } from "@/core/analysis/pipeline";
import { closeDb, collections, newId } from "@/lib/db";
import { makeSnapshot } from "./helpers";

const facts = (over: Partial<TrustFacts> = {}): TrustFacts => ({
  sources: ["jupiter", "rugcheck"], listed: false, organicScore: 80, honeypot: null, sellSimulated: null, buyTaxPct: null, sellTaxPct: null, openSource: null,
  mintable: null, upgradeableProxy: null, hiddenOwner: null, canReclaimOwnership: null, pausable: null, blacklist: null, lpLockedPct: 100, holders: 800,
  creatorPct: 1, rugged: false, dangers: [], cautions: [], ...over,
});
const raw = (over: Partial<OnChainRaw> = {}, trust: Partial<TrustFacts> | null = {}): OnChainRaw => ({
  mintAuthorityRevoked: true, freezeAuthorityRevoked: true, verified: false, topHolderPct: 0, top10HolderPct: 0, sellSimulationOk: true, metadataAnomalies: [],
  largeBuys1h: 0, largeSells1h: 0, largeBuyUsd1h: 0, largeSellUsd1h: 0, newHolders1h: 0, liquidityAddedUsd1h: 0, liquidityRemovedUsd1h: 0, suspiciousTxRatio: 0,
  poolActive: true, dataAvailable: true, ...(trust === null ? {} : { trust: facts(trust) }), ...over,
});
const NOW = new Date("2026-10-06T12:00:00Z");
const ago = (h: number) => new Date(NOW.getTime() - h * 3_600_000);
/** a Solana token that clears every bar: $120K pool, 3 days old, 800 holders */
const solid = (over = {}) => makeSnapshot({ chain: "solana", liquidityUsd: 120_000, volume24h: 90_000, poolCreatedAt: ago(72), holders: -1, ...over });
const evmSnap = (over = {}) => makeSnapshot({ chain: "base", address: "0x" + "a".repeat(40), liquidityUsd: 120_000, volume24h: 90_000, poolCreatedAt: ago(72), holders: -1, ...over });
const evmClean: Partial<TrustFacts> = { sources: ["goplus", "honeypot.is"], honeypot: false, sellSimulated: true, buyTaxPct: 0, sellTaxPct: 0, openSource: true, mintable: false, upgradeableProxy: false, hiddenOwner: false, canReclaimOwnership: false, pausable: false, blacklist: false };
const tier = (s: ReturnType<typeof makeSnapshot>, r: OnChainRaw) => assessTrust(s, r, NOW).tier;

describe("parsers read each service's real response shape", () => {
  it("Jupiter: a brand-new unlisted token is not 'listed', has a 0 organic score; a verified one is listed", () => {
    const snipe = [{ id: "G1yq", name: "SnipeKiller", isVerified: null, organicScore: 0, organicScoreLabel: "low", tags: ["unknown", "token-2022"], holderCount: 58, audit: { mintAuthorityDisabled: true, devBalancePercentage: 3.68 } }];
    expect(parseJupiter(snipe, "G1yq")).toEqual({ listed: false, organicScore: 0, holders: 58, creatorPct: 3.68 });
    const jup = [{ id: "JUP", isVerified: true, organicScore: 98, tags: ["defi", "strict", "verified"], holderCount: 838587 }];
    expect(parseJupiter(jup, "JUP")).toMatchObject({ listed: true, organicScore: 98, holders: 838587 });
    // "community" only means holders voted for it
    expect(parseJupiter([{ id: "X", isVerified: false, tags: ["community"] }], "X")?.listed).toBe(false);
    // search returns lookalikes too: only the entry whose id is the mint counts
    expect(parseJupiter([{ id: "OTHER", isVerified: true, tags: ["verified"] }], "X")).toBeNull();
    expect(parseJupiter({ error: "x" }, "X")).toBeNull();
  });

  it("RugCheck: weights locked liquidity by pool size, reads dangers/cautions, rug flag and the creator's share", () => {
    const report = {
      rugged: false, totalHolders: 5108, creatorBalance: 1_000_001, token: { supply: 966_010_757_274_714 }, transferFee: { pct: 0 },
      risks: [{ name: "Low Liquidity", level: "warn" }, { name: "Freeze Authority still enabled", level: "danger" }],
      markets: [
        { lp: { quoteUSD: 21_368.8, baseUSD: 23_499.8, lpLockedUSD: 44_868.6, lpLockedPct: 100 } }, // the real pool, fully locked
        { lp: { quoteUSD: 1_101, baseUSD: 1_095.9, lpLockedUSD: 0, lpLockedPct: 0 } }, // a small open one
      ],
    };
    const p = parseRugCheck(report)!;
    expect(p.lpLockedPct).toBeCloseTo((44_868.6 / (44_868.6 + 2_196.9)) * 100, 4); // ~95%, not the first market's 100
    expect(p).toMatchObject({ rugged: false, holders: 5108, dangers: ["Freeze Authority still enabled"], cautions: ["Low Liquidity"] });
    expect(p.creatorPct).toBeCloseTo(0, 4);
    expect(parseRugCheck({ rugged: true, risks: [], markets: [] })?.rugged).toBe(true);
    // measured on the real BONK/WIF/JUP and on a copycat "Bonk" with $1.7M of liquidity: pool-vault noise is a caution, a copycat is a danger
    const noisy = parseRugCheck({ rugged: false, markets: [], risks: [
      { name: "Single holder ownership", level: "danger" }, { name: "Large Amount of LP Unlocked", level: "danger" }, { name: "Low Liquidity", level: "danger" },
      { name: "Copycat token", level: "warn" }, { name: "Mutable metadata", level: "warn" }, { name: "Freeze Authority still enabled", level: "danger" },
    ] })!;
    expect([...noisy.dangers!].sort()).toEqual(["Copycat token", "Freeze Authority still enabled"]);
    expect(noisy.cautions).toEqual(expect.arrayContaining(["Single holder ownership", "Large Amount of LP Unlocked", "Low Liquidity", "Mutable metadata"]));
    expect(noisy.cautions).not.toContain("Copycat token");
    expect(parseRugCheck({ ...report, transferFee: { pct: 5 } })?.dangers).toContain("Token charges a 5% transfer fee");
    expect(parseRugCheck({ error: "not found" })).toBeNull();
    expect(parseRugCheck(null)).toBeNull();
  });

  it("GoPlus: '0'/'1' strings become booleans, fractions become percents, LP held by a locker or burn address counts as locked", () => {
    const addr = "0xe022e0b5ec9ab4fb4932c67378726a8fbcb17777";
    const clean = {
      result: { [addr]: { is_honeypot: "0", buy_tax: "0", sell_tax: "0.02", is_open_source: "1", is_proxy: "0", is_mintable: "0", hidden_owner: "0", can_take_back_ownership: "0", transfer_pausable: "0", is_blacklisted: "0", holder_count: "154", creator_percent: "0.031", trust_list: "1",
        lp_holders: [{ address: "0x000000000000000000000000000000000000dEaD", percent: "0.6", is_locked: 0 }, { address: "0xlocker", percent: "0.3", is_locked: 1 }, { address: "0xowner", percent: "0.1", is_locked: 0 }] } },
    };
    const p = parseGoPlus(clean, "0xE022e0b5Ec9ab4FB4932c67378726A8Fbcb17777")!;
    expect(p).toMatchObject({ honeypot: false, buyTaxPct: 0, openSource: true, mintable: false, upgradeableProxy: false, hiddenOwner: false, pausable: false, holders: 154, listed: true });
    expect(p.sellTaxPct).toBeCloseTo(2, 6);
    expect(p.creatorPct).toBeCloseTo(3.1, 6);
    expect(p.lpLockedPct).toBeCloseTo(90, 6);
    const bad = parseGoPlus({ result: { [addr]: { is_honeypot: "1", cannot_sell_all: "1", honeypot_with_same_creator: "1", slippage_modifiable: "1", is_mintable: "1", hidden_owner: "1", owner_change_balance: "1" } } }, addr)!;
    expect(bad).toMatchObject({ honeypot: true, mintable: true, hiddenOwner: true });
    expect(bad.dangers).toEqual(expect.arrayContaining(["The creator has launched honeypots before", "Holders can't sell their whole balance", "The owner can change the trading tax at will", "The owner can change holders' balances"]));
    // an unsupported chain / unknown contract comes back with no result: nothing is claimed
    expect(parseGoPlus({ code: 2007, message: "Not contract address!", result: null }, addr)).toBeNull();
    // a field GoPlus leaves out stays unknown, it is not read as "false"
    expect(parseGoPlus({ result: { [addr]: { is_honeypot: "0" } } }, addr)).toMatchObject({ honeypot: false, openSource: null, mintable: null, lpLockedPct: null });
  });

  it("honeypot.is: only trusts taxes and 'not a honeypot' when the simulation actually ran", () => {
    expect(parseHoneypotIs({ simulationSuccess: true, honeypotResult: { isHoneypot: false }, simulationResult: { buyTax: 0, sellTax: 0 } })).toMatchObject({ honeypot: false, sellSimulated: true, buyTaxPct: 0, sellTaxPct: 0 });
    const hp = parseHoneypotIs({ simulationSuccess: true, honeypotResult: { isHoneypot: true, honeypotReason: "TRANSFER_FAILED" }, simulationResult: { buyTax: 1, sellTax: 100 } })!;
    expect(hp).toMatchObject({ honeypot: true, sellTaxPct: 100 });
    expect(hp.dangers).toEqual(["Honeypot: TRANSFER_FAILED"]);
    expect(parseHoneypotIs({ simulationSuccess: false, honeypotResult: { isHoneypot: false }, simulationResult: { buyTax: 0, sellTax: 0 } })).toMatchObject({ honeypot: null, sellSimulated: false, buyTaxPct: null, sellTaxPct: null });
    expect(parseHoneypotIs({ error: "unsupported chain" })).toBeNull();
  });

  it("merging: a definite answer beats unknown, and the worse figure wins", () => {
    const m = mergeTrustFacts([
      { source: "goplus", facts: { honeypot: false, sellTaxPct: 1, lpLockedPct: 90, listed: true, dangers: ["a"] } },
      { source: "honeypot.is", facts: { honeypot: true, sellTaxPct: 12, sellSimulated: true, dangers: ["a", "b"] } },
      { source: "down", facts: null },
    ]);
    expect(m).toMatchObject({ sources: ["goplus", "honeypot.is"], honeypot: true, sellTaxPct: 12, lpLockedPct: 90, listed: true, sellSimulated: true, dangers: ["a", "b"] });
    expect(mergeTrustFacts([{ source: "x", facts: null }])).toMatchObject({ sources: [], honeypot: null, listed: null });
  });
});

describe("what each kind of token earns", () => {
  it("a brand-new pump.fun-style token: every authority is revoked and nothing was flagged, yet it is only UNPROVEN, and says why", () => {
    const r = assessTrust(solid({ liquidityUsd: 5_200, volume24h: 3_400, poolCreatedAt: ago(22), holders: 58 }), raw({}, { organicScore: 0, holders: 58 }), NOW);
    expect(r.tier).toBe("UNPROVEN");
    expect(r.summary).toMatch(/hasn't earned trust yet/);
    expect(r.missing.join(" ")).toMatch(/\$5,200 in the pool, trust needs \$50,000/);
    expect(r.missing.join(" ")).toMatch(/Only 22h old/);
    expect(r.checks.find((c) => c.id === "organic")).toMatchObject({ status: "fail" });
  });

  it("deep, old, locked, spread across holders, organic: TRUSTED. Also on Jupiter's verified list: VERIFIED", () => {
    expect(tier(solid(), raw())).toBe("TRUSTED");
    const v = assessTrust(solid(), raw({ verified: true }, { listed: true }), NOW);
    expect(v.tier).toBe("VERIFIED");
    expect(v.summary).toMatch(/Jupiter's verified list/);
  });

  it("a listed token still needs real liquidity, but not the history or holder count", () => {
    expect(tier(solid({ liquidityUsd: 20_000 }), raw({}, { listed: true }))).toBe("UNPROVEN");
    expect(tier(solid({ poolCreatedAt: ago(5) }), raw({}, { listed: true, holders: 40 }))).toBe("VERIFIED");
  });

  it("young is UNPROVEN even when everything else is perfect (22h), and TRUSTED a day later", () => {
    expect(tier(solid({ poolCreatedAt: ago(22) }), raw())).toBe("UNPROVEN");
    expect(tier(solid({ poolCreatedAt: ago(25) }), raw())).toBe("TRUSTED");
  });

  it("active mint or freeze authority on Solana is RISKY however deep the pool", () => {
    expect(assessTrust(solid({ liquidityUsd: 900_000 }), raw({ freezeAuthorityRevoked: false }), NOW).summary).toMatch(/freeze authority is still active/);
    expect(tier(solid({ liquidityUsd: 900_000 }), raw({ freezeAuthorityRevoked: false }))).toBe("RISKY");
    expect(tier(solid(), raw({ mintAuthorityRevoked: false }))).toBe("RISKY");
  });

  it("named dangers, unlocked liquidity on a modest pool, and a creator holding a fifth are RISKY", () => {
    expect(tier(solid(), raw({}, { dangers: ["Freeze Authority still enabled"] }))).toBe("RISKY");
    expect(tier(solid(), raw({}, { lpLockedPct: 10 }))).toBe("RISKY");
    expect(tier(solid(), raw({}, { creatorPct: 25 }))).toBe("RISKY");
    // between 50% and 70% locked isn't a flag, it just hasn't earned trust
    expect(tier(solid(), raw({}, { lpLockedPct: 60 }))).toBe("UNPROVEN");
    // a $400K pool that is only 3 days old and almost entirely unlocked can still be pulled
    expect(tier(solid({ liquidityUsd: 400_000 }), raw({}, { lpLockedPct: 10 }))).toBe("RISKY");
  });

  it("an established deep pool isn't held to the lock rule: BONK, WIF and JUP read 14%, 48% and 1% 'locked' (concentrated-liquidity pools can't be locked)", () => {
    expect(tier(solid({ liquidityUsd: 400_000, poolCreatedAt: ago(200) }), raw({}, { lpLockedPct: 10 }))).toBe("TRUSTED");
    expect(tier(solid({ liquidityUsd: 400_000, poolCreatedAt: ago(200) }), raw({}, { lpLockedPct: null }))).toBe("TRUSTED");
    // ...but it is still not trusted on depth alone: a shallow or recent pool needs the lock
    expect(tier(solid({ liquidityUsd: 100_000, poolCreatedAt: ago(200) }), raw({}, { lpLockedPct: 10 }))).toBe("RISKY");
    expect(tier(solid({ liquidityUsd: 100_000, poolCreatedAt: ago(200) }), raw({}, { lpLockedPct: null }))).toBe("UNPROVEN");
    // and a curated list vouches for its tokens' pools
    expect(tier(solid({ liquidityUsd: 100_000 }), raw({}, { lpLockedPct: 1, listed: true }))).toBe("VERIFIED");
  });

  it("a curated list vouches for ordinary admin powers (CAKE can mint, USDC can pause and blacklist), but never for a hidden owner", () => {
    const cake = { ...evmClean, mintable: true, upgradeableProxy: true, pausable: true, blacklist: true, listed: true };
    expect(tier(evmSnap(), raw({ mintAuthorityRevoked: false }, cake))).toBe("VERIFIED");
    expect(tier(evmSnap(), raw({ mintAuthorityRevoked: false }, { ...cake, listed: false }))).toBe("RISKY");
    expect(tier(evmSnap(), raw({}, { ...cake, hiddenOwner: true }))).toBe("RISKY");
    expect(tier(evmSnap(), raw({}, { ...cake, sellTaxPct: 30 }))).toBe("DANGEROUS");
  });

  it("a rugged token and a honeypot are DANGEROUS, from any source", () => {
    expect(tier(solid(), raw({}, { rugged: true }))).toBe("DANGEROUS");
    expect(tier(solid(), raw({ sellSimulationOk: false }))).toBe("DANGEROUS");
    expect(tier(evmSnap(), raw({}, { ...evmClean, honeypot: true }))).toBe("DANGEROUS");
  });

  it("when no service could be reached nothing is confirmed: UNPROVEN, never TRUSTED", () => {
    const r = assessTrust(solid({ liquidityUsd: 900_000, holders: 5_000 }), raw({}, null), NOW);
    expect(r.tier).toBe("UNPROVEN");
    expect(r.summary).toMatch(/No verification service could be reached/);
    expect(r.sources).toEqual([]);
  });

  it("EVM: a clean contract with a real sell simulation is TRUSTED; taxes, powers and unknowns move it down", () => {
    expect(tier(evmSnap(), raw({ mintAuthorityRevoked: true }, evmClean))).toBe("TRUSTED");
    expect(tier(evmSnap(), raw({}, { ...evmClean, sellTaxPct: 20 }))).toBe("DANGEROUS"); // the tax takes most of what you'd get back
    expect(tier(evmSnap(), raw({}, { ...evmClean, sellTaxPct: 8 }))).toBe("RISKY");
    expect(tier(evmSnap(), raw({}, { ...evmClean, mintable: true }))).toBe("RISKY");
    expect(tier(evmSnap(), raw({}, { ...evmClean, hiddenOwner: true }))).toBe("RISKY");
    expect(tier(evmSnap(), raw({}, { ...evmClean, openSource: false }))).toBe("RISKY");
    // pausing/blacklisting only matters while someone still holds the keys
    expect(tier(evmSnap(), raw({ mintAuthorityRevoked: false }, { ...evmClean, blacklist: true }))).toBe("RISKY");
    expect(tier(evmSnap(), raw({ mintAuthorityRevoked: true }, { ...evmClean, blacklist: true }))).toBe("TRUSTED");
    // no simulated sell (honeypot.is didn't support the chain): can't say it's sellable
    expect(tier(evmSnap(), raw({}, { ...evmClean, honeypot: false, sellSimulated: false }))).toBe("UNPROVEN");
    // GoPlus's own trusted list makes it VERIFIED
    expect(tier(evmSnap(), raw({ mintAuthorityRevoked: true, verified: true }, { ...evmClean, listed: true }))).toBe("VERIFIED");
  });

  it("every check is listed with what it found, and nothing passes silently when unknown", () => {
    const r = assessTrust(evmSnap(), raw({}, { ...evmClean, openSource: null }), NOW);
    expect(r.checks.find((c) => c.id === "source")).toMatchObject({ status: "unknown" });
    expect(r.tier).toBe("UNPROVEN");
    expect(new Set(r.checks.map((c) => c.id)).size).toBe(r.checks.length);
  });

  it("the bar is the one written down: $50K liquidity, $20K volume, 24h", () => {
    expect(TRUST_BAR).toMatchObject({ minLiquidityUsd: 50_000, minVolume24hUsd: 20_000, minAgeHours: 24 });
    expect(tier(solid({ liquidityUsd: 49_000 }), raw())).toBe("UNPROVEN");
    expect(tier(solid({ liquidityUsd: 50_000 }), raw())).toBe("TRUSTED");
    expect(tier(solid({ volume24h: 15_000 }), raw())).toBe("UNPROVEN");
  });
});

describe("trust gates what gets bought and what gets signalled", () => {
  const limits = { maxPriceImpactPct: 3, maxSlippageBps: 300, minLiquidityUsd: 20_000, minVolume24hUsd: 10_000, minOpportunityScore: 0, maxAllowedRisk: "HIGH" as const };
  const quote = quoteFromImpact({ chain: "solana", side: "BUY", tokenAddress: "x", priceUsd: 1, amountUsd: 10, impactPct: 0.5, slippageBps: 100, priorityFeeNative: 0, route: ["r"], source: "LIVE" });
  const cand = (t: ReturnType<typeof assessTrust>) => ({ liquidityUsd: 500_000, volume24hUsd: 500_000, opportunityScore: 80, safety: { riskScore: 5, riskLevel: "LOWER" as const, passed: true, warnings: [], criticalIssues: [] }, quote, sellSimulationOk: true, trust: t });
  const unproven = assessTrust(solid({ poolCreatedAt: ago(22) }), raw(), NOW);
  const trusted = assessTrust(solid(), raw(), NOW);
  const dangerous = assessTrust(solid(), raw({}, { rugged: true }), NOW);

  it("the bot refuses anything below its minimum trust; a person can still decide for themselves", () => {
    expect(validateEntry(cand(unproven), { ...limits, minTrust: "TRUSTED" }, { automatic: true }).join()).toMatch(/Trust: Unproven, below the Trusted minimum/);
    expect(validateEntry(cand(unproven), { ...limits, minTrust: "UNPROVEN" }, { automatic: true })).toEqual([]);
    expect(validateEntry(cand(trusted), { ...limits, minTrust: "TRUSTED" }, { automatic: true })).toEqual([]);
    expect(validateEntry(cand(trusted), { ...limits, minTrust: "VERIFIED" }, { automatic: true }).join()).toMatch(/below the Verified minimum/);
    expect(validateEntry(cand(unproven), { ...limits, minTrust: "TRUSTED" }, { automatic: false })).toEqual([]); // manual: acknowledged in the UI and on the server instead
  });

  it("a dangerous token is blocked for everyone, hand-made buys included", () => {
    expect(validateEntry(cand(dangerous), { ...limits, minTrust: "UNPROVEN" }, { automatic: false }).join()).toMatch(/Dangerous token/);
    expect(validateEntry(cand(dangerous), { ...limits, minTrust: "UNPROVEN" }, { automatic: true }).join()).toMatch(/Dangerous token/);
    expect(entryWarnings(cand(trusted), { ...limits, minTrust: "TRUSTED" })).toEqual([]);
  });

  it("no signal is raised for a token that hasn't earned trust", () => {
    const mk = (r: OnChainRaw, s = solid()) => {
      const a = buildAnalysis(s, r, [], "5m", undefined, NOW);
      a.opportunity = { ...a.opportunity, score: 90 };
      return a;
    };
    expect(generateSignal(mk(raw()))).not.toBeNull();
    expect(generateSignal(mk(raw({}, { dangers: ["x"] })))).toBeNull();
    expect(generateSignal(mk(raw(), solid({ poolCreatedAt: ago(22) })))).toBeNull(); // 22 hours old: not yet
    expect(generateSignal(mk(raw({}, null)))).toBeNull(); // unchecked
  });
});

describe("the safety score uses what the services found", () => {
  it("flags rugs, heavy taxes, a dominant creator and unlocked liquidity", () => {
    const base = solid({ liquidityUsd: 80_000, liquidity1hAgoUsd: 80_000 });
    expect(assessSafety(base, raw({}, { rugged: true })).criticalIssues.join()).toMatch(/rugged/);
    expect(assessSafety(base, raw({}, { sellTaxPct: 30 })).criticalIssues.join()).toMatch(/Trading tax is 30%/);
    expect(assessSafety(base, raw({}, { sellTaxPct: 7 })).warnings.join()).toMatch(/High trading tax \(7%\)/);
    expect(assessSafety(base, raw({}, { creatorPct: 31 })).warnings.join()).toMatch(/Creator wallet holds 31%/);
    expect(assessSafety(base, raw({}, { lpLockedPct: 5 })).warnings.join()).toMatch(/Only 5% of the liquidity is locked/);
    expect(assessSafety(base, raw({}, { dangers: ["Mint Authority still enabled"] })).warnings).toContain("Mint Authority still enabled");
    expect(assessSafety(base, raw()).criticalIssues).toEqual([]);
  });
});

describe("fetching: never throws, never invents, asks once", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    resetTrustCache();
  });
  const ok = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });

  it("combines the two Solana services, reading the mint out of Jupiter's search results", async () => {
    const calls: string[] = [];
    vi.stubGlobal("fetch", async (u: string) => {
      calls.push(String(u));
      if (String(u).includes("lite-api.jup.ag")) return ok([{ id: "MintAddr", isVerified: true, organicScore: 90, tags: ["verified"], holderCount: 1234 }]);
      return ok({ rugged: false, risks: [], markets: [{ lp: { quoteUSD: 10, baseUSD: 10, lpLockedUSD: 20 } }], totalHolders: 1200, creatorBalance: 0, token: { supply: 100 } });
    });
    const f = await fetchTrustFacts("solana", "MintAddr");
    expect(f).toMatchObject({ sources: ["jupiter", "rugcheck"], listed: true, rugged: false, lpLockedPct: 100, organicScore: 90 });
    await fetchTrustFacts("solana", "MintAddr"); // cached: no new requests
    expect(calls).toHaveLength(2);
  });

  it("when every service is down the facts are empty (no sources), not 'fine'", async () => {
    vi.stubGlobal("fetch", async () => new Response("down", { status: 500 }));
    const f = await fetchTrustFacts("base", "0x" + "b".repeat(40));
    expect(f.sources).toEqual([]);
    expect(f.honeypot).toBeNull();
    expect(assessTrust(evmSnap(), raw({}, f), NOW).tier).toBe("UNPROVEN");
  });

  it("a service that rate-limits (429) is left alone for a while instead of being hammered by every token", async () => {
    let hits = 0;
    vi.stubGlobal("fetch", async (u: string) => {
      if (String(u).includes("gopluslabs")) {
        hits++;
        return new Response("slow down", { status: 429 });
      }
      return ok({ simulationSuccess: true, honeypotResult: { isHoneypot: false }, simulationResult: { buyTax: 0, sellTax: 0 } });
    });
    const a = await fetchTrustFacts("base", "0x" + "c".repeat(40));
    const b = await fetchTrustFacts("base", "0x" + "d".repeat(40));
    expect(hits).toBe(1); // the second token never asked GoPlus
    expect(a.sources).toEqual(["honeypot.is"]);
    expect(b.sources).toEqual(["honeypot.is"]);
  });

  it("a chain GoPlus and honeypot.is don't cover gets no answer from either: unproven", async () => {
    vi.stubGlobal("fetch", async () => ok({ code: 2007, message: "unsupported", result: null }));
    const f = await fetchTrustFacts("base", "0x" + "e".repeat(40));
    expect(f.sources).toEqual([]);
  });
});

let dbUp = false;
try {
  await (await collections.users()).findOne({});
  dbUp = true;
} catch {
  dbUp = false;
}
afterAll(async () => {
  if (dbUp) await closeDb();
});

(dbUp ? describe : describe.skip)("lists and the manual-buy acknowledgement", () => {
  const userId = newId();
  const ids: string[] = [];
  let mock: Awaited<ReturnType<typeof analysed>>;

  async function analysed() {
    const { runScanCycle } = await import("@/services/scanner");
    const { runAnalysisCycle } = await import("@/services/analysis");
    const tokens = await collections.tokens();
    const find = () => tokens.findOne({ passedFilters: true, analysis: { $ne: null }, chain: "solana" }, { sort: { liquidityUsd: -1 } });
    let t = await find();
    if (!t) {
      await runScanCycle({ chainsPerTick: 0 });
      await runAnalysisCycle(8);
      t = await find();
    }
    if (!t) throw new Error("no analysed mock token available");
    return t;
  }

  beforeAll(async () => {
    mock = await analysed();
    const now = new Date();
    await (await collections.users()).insertOne({ _id: userId, email: `trust-${Date.now()}@test.local`, passwordHash: "x", name: null, role: "USER", createdAt: now });
    await (await collections.tradingAccounts()).insertOne({ _id: newId(), userId, environment: "LIVE", realizedPnlUsd: 0, createdAt: now });
    await (await collections.wallets()).insertOne({ _id: newId(), userId, chain: "solana", address: "W".repeat(44), label: null, verifiedAt: now, createdAt: now });
    const { getSettings } = await import("@/services/settings");
    await getSettings(userId);
    await (await collections.tradingSettings()).updateOne({ userId }, { $set: { minOpportunityScore: 0, minLiquidityUsd: 0, minVolume24hUsd: 0, maxPriceImpactPct: 50, maxAllowedRisk: "HIGH" } });
  });
  afterEach(() => vi.restoreAllMocks());
  afterAll(async () => {
    await Promise.all([
      (await collections.users()).deleteOne({ _id: userId }), (await collections.tradingAccounts()).deleteMany({ userId }), (await collections.wallets()).deleteMany({ userId }),
      (await collections.tradingSettings()).deleteMany({ userId }), (await collections.trades()).deleteMany({ userId }), (await collections.tokens()).deleteMany({ _id: { $in: ids } }),
    ]).catch(() => {});
  });

  it("the token lists can be limited to a trust tier, and say how many were left out", async () => {
    const { listTokens, tokenQuerySchema } = await import("@/services/queries");
    const tokens = await collections.tokens();
    const tag = `xtrust${Date.now()}`;
    const mk = (tierName: string | null, i: number) => ({ ...mock, _id: newId(), address: `${tag}${i}`.padEnd(32, "0"), chain: tag, trustTier: tierName, lastScannedAt: new Date() }) as never;
    const docs = [mk("VERIFIED", 1), mk("TRUSTED", 2), mk("UNPROVEN", 3), mk("RISKY", 4), mk("DANGEROUS", 5), mk(null, 6)] as { _id: string }[];
    ids.push(...docs.map((d) => d._id));
    await tokens.insertMany(docs as never);
    const q = (trust?: string) => tokenQuerySchema.parse({ chain: tag, passing: "false", ...(trust ? { trust } : {}), pageSize: 50 });
    const all = await listTokens(q());
    expect(all.total).toBe(6);
    expect(all.untrustedHidden).toBe(0);
    const trusted = await listTokens(q("TRUSTED"));
    expect(trusted.rows.map((r) => (r as { trustTier?: string }).trustTier).sort()).toEqual(["TRUSTED", "VERIFIED"]);
    expect(trusted.untrustedHidden).toBe(4); // unproven, risky, dangerous, and the one never checked
    expect((await listTokens(q("VERIFIED"))).total).toBe(1);
    expect((await listTokens(q("UNPROVEN"))).total).toBe(3); // hides risky, dangerous and unchecked
    expect((await listTokens(q("ALL"))).total).toBe(6);
  });

  it("analysis stores the trust tier and its checks on the token", async () => {
    const t = await (await collections.tokens()).findOne({ _id: mock._id });
    expect(["VERIFIED", "TRUSTED", "UNPROVEN", "RISKY", "DANGEROUS"]).toContain(t?.trustTier);
    expect(t?.trust?.checks.length).toBeGreaterThan(5);
    expect(t?.trust?.summary).toBeTruthy();
  });

  async function forceTrust(sources: string[]) {
    // an old analysis is recomputed on the next quote; give that recomputation the on-chain facts a given kind of token would have
    await (await collections.tokens()).updateOne({ _id: mock._id }, { $set: { "analysis.computedAt": new Date(0), priceUsd: mock.priceUsd, lastScannedAt: new Date() } });
    const { providers } = await import("@/core/providers/registry");
    const real = providers().data.getOnChain.bind(providers().data);
    vi.spyOn(providers().data, "getOnChain").mockImplementation(async (c, a, s) => {
      const r = await real(c, a, s);
      return { ...r, trust: sources.length ? r.trust : undefined };
    });
    vi.spyOn(providers().dex, "buildSwapTransaction").mockResolvedValue({ unsignedTxBase64: "unsigned" });
  }
  const input = () => ({ chain: "solana" as const, tokenAddress: mock.address, amountUsd: 5, slippageBps: 100, environment: "LIVE" as const });

  it("a hand-made buy of a token that hasn't earned trust needs the acknowledgement; with it, the buy goes through", async () => {
    const { prepareTrade } = await import("@/services/trading");
    await forceTrust([]); // no verification could be reached for this token
    await expect(prepareTrade(userId, input(), "MANUAL_ENTRY")).rejects.toMatchObject({ status: 409, hint: { needsTrustAck: 1 } });
    const ok = await prepareTrade(userId, { ...input(), acknowledgeTrust: true }, "MANUAL_ENTRY");
    expect(ok.trade.status).toBe("PREPARED");
  });

  it("the bot never buys it, acknowledged or not", async () => {
    const { prepareTrade } = await import("@/services/trading");
    await forceTrust([]);
    await expect(prepareTrade(userId, { ...input(), acknowledgeTrust: true }, "AUTO_ENTRY")).rejects.toMatchObject({ status: 422, violations: [expect.stringMatching(/Trust: Unproven/)] });
  });
});
