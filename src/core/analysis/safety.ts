import { CHAINS } from "../chains";
import type { OnChainRaw, RiskLevel, SafetyResult, TokenSnapshot } from "../types";
import { constantProductImpactPct } from "../trading/quoteMath";

export function riskLevelFromScore(score: number, hasCritical: boolean): RiskLevel {
  if (hasCritical || score >= 70) return "CRITICAL";
  if (score >= 45) return "HIGH";
  if (score >= 20) return "MODERATE";
  return "LOWER";
}

export const RISK_LABEL: Record<RiskLevel, string> = {
  LOWER: "LOWER RISK",
  MODERATE: "MODERATE RISK",
  HIGH: "HIGH RISK",
  CRITICAL: "CRITICAL RISK",
};

/**
 * Heuristic safety screen. A passing result means "no red flags were detected by these checks" — it is not a
 * guarantee the token is safe, and the UI must never describe it as such.
 */
export function assessSafety(snap: TokenSnapshot, raw: OnChainRaw): SafetyResult {
  const warnings: string[] = [];
  const critical: string[] = [];
  let score = 0;
  const warn = (msg: string, pts: number) => {
    warnings.push(msg);
    score += pts;
  };
  const crit = (msg: string, pts: number) => {
    critical.push(msg);
    score += pts;
  };

  // A failed RPC lookup is "unknown", not "authority still active". Scoring placeholders as findings used to
  // stack ~+38 risk points on every token whose public-RPC call merely timed out, pushing otherwise fine
  // tokens over the safety cutoff — so unverifiable data now costs one small, clearly-labelled penalty.
  const onchainKnown = raw.dataAvailable !== false;
  if (!onchainKnown) {
    warn("On-chain authority/holder checks were unavailable (RPC timeout) — treat as unverified", 6);
  } else if (CHAINS[snap.chain]?.family === "evm") {
    // For EVM the only signal is whether the contract owner is renounced; an active owner is common on
    // legitimate tokens and doesn't distinguish mint vs. freeze power, so it is one moderate warning.
    if (!raw.mintAuthorityRevoked) warn("Contract owner is not renounced — owner can change token parameters", 10);
  } else {
    if (!raw.mintAuthorityRevoked) warn("Mint authority is not revoked — supply can be inflated", 18);
    if (!raw.freezeAuthorityRevoked) warn("Freeze authority is not revoked — token accounts can be frozen", 12);
  }
  if (!raw.verified) warn("Token is not verified by any tracked list", 4);

  if (!raw.poolActive) crit("Liquidity pool is inactive or removed", 60);
  if (!raw.sellSimulationOk) crit("Sell simulation failed — honeypot-like behaviour", 60);

  if (snap.liquidityUsd < 10_000) crit(`Liquidity critically low ($${Math.round(snap.liquidityUsd).toLocaleString()})`, 35);
  else if (snap.liquidityUsd < 50_000) warn("Liquidity is thin (< $50K)", 10);

  if (snap.liquidity1hAgoUsd > 0) {
    const drop = (1 - snap.liquidityUsd / snap.liquidity1hAgoUsd) * 100;
    if (drop >= 70) crit(`Liquidity collapsed ${drop.toFixed(0)}% in the last hour`, 45);
    else if (drop >= 30) warn(`Liquidity dropped ${drop.toFixed(0)}% in the last hour`, 15);
  }

  const holdersKnown = onchainKnown && raw.holderDataAvailable !== false;
  if (!holdersKnown) {
    // unknown holder data is not a finding: no points. When authorities WERE readable, just say what is missing.
    if (onchainKnown) warn("Top-holder concentration unavailable (needs a Solana RPC that serves it; see Integrations)", 0);
  } else if (raw.topHolderPct >= 35) crit(`Single holder controls ${raw.topHolderPct.toFixed(1)}% of supply`, 25);
  else if (raw.topHolderPct >= 20) warn(`Top holder controls ${raw.topHolderPct.toFixed(1)}% of supply`, 12);
  if (raw.top10HolderPct >= 80) warn(`Top 10 holders control ${raw.top10HolderPct.toFixed(0)}% of supply`, 18);
  else if (raw.top10HolderPct >= 60) warn(`Top 10 holders control ${raw.top10HolderPct.toFixed(0)}% of supply`, 8);

  if (onchainKnown) for (const a of raw.metadataAnomalies) warn(a, 8);

  if (raw.suspiciousTxRatio >= 0.5) crit("Majority of transactions look bot/wash-like", 25);
  else if (raw.suspiciousTxRatio >= 0.3) warn("Elevated share of suspicious (bot/wash-like) transactions", 15);

  const total1h = snap.buys1h + snap.sells1h;
  if (snap.buys1h >= 30 && snap.sells1h / Math.max(1, total1h) < 0.08) {
    crit("Buys vastly outnumber sells — possible sell restriction", 35);
  }
  if (total1h < 20) warn("Very low transaction activity in the last hour", 6);

  if (snap.holders >= 0 && snap.holders < 100) warn(`Few holders (${snap.holders})`, 8);

  const impact = constantProductImpactPct(100, snap.liquidityUsd);
  if (impact >= 15) crit(`Extreme price impact for a $100 order (${impact.toFixed(1)}%)`, 25);
  else if (impact >= 5) warn(`High price impact for a $100 order (${impact.toFixed(1)}%)`, 10);

  const riskScore = Math.min(100, score);
  const riskLevel = riskLevelFromScore(riskScore, critical.length > 0);
  return {
    riskScore,
    riskLevel,
    passed: critical.length === 0 && riskScore < 45,
    warnings,
    criticalIssues: critical,
  };
}
