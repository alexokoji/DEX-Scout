import type { OnChainAnalysis, OnChainRaw, SafetyResult, TokenSnapshot, MarketAnalysis } from "../types";
import { constantProductImpactPct } from "./quoteMath";

export type Health = "HOLD" | "MONITOR" | "WARNING" | "EMERGENCY";

export interface EmergencyConfig {
  enabled: boolean;
  liquidityDropPct: number; // vs liquidity at entry
}

export interface EmergencyInput {
  snapshot: TokenSnapshot | null; // null => token can no longer be found
  raw: OnChainRaw | null;
  safety: SafetyResult | null;
  market: MarketAnalysis | null;
  onchain: OnChainAnalysis | null;
  liquidityAtEntryUsd: number;
  positionValueUsd: number;
}

export interface HealthAssessment {
  health: Health;
  /** catastrophic conditions only — never price loss alone */
  emergency: boolean;
  emergencyReasons: string[];
  positives: string[];
  negatives: string[];
}

/**
 * Re-assess an open position.
 *
 * IMPORTANT: unrealised loss is deliberately NOT an input to this function. A position at -5/-10/-20% with
 * healthy liquidity/volume/holders is reported as HOLD/MONITOR. `emergency` is only true for catastrophic,
 * execution-level failures (untradeable token, pool gone, sell simulation failure, liquidity collapse,
 * critical security condition, extreme execution risk) and only when protection is enabled.
 */
export function assessPosition(i: EmergencyInput, cfg: EmergencyConfig): HealthAssessment {
  const emergencyReasons: string[] = [];
  const positives: string[] = [];
  const negatives: string[] = [];

  if (!i.snapshot || !i.raw) {
    emergencyReasons.push("Token is no longer tradeable (no market data / pool)");
  } else {
    const s = i.snapshot;
    if (!i.raw.poolActive) emergencyReasons.push("Liquidity pool disappeared or is inactive");
    if (!i.raw.sellSimulationOk) emergencyReasons.push("Sell simulation failed");
    if (i.liquidityAtEntryUsd > 0) {
      const drop = (1 - s.liquidityUsd / i.liquidityAtEntryUsd) * 100;
      if (drop >= cfg.liquidityDropPct) emergencyReasons.push(`Liquidity down ${drop.toFixed(0)}% since entry`);
      else if (drop >= 30) negatives.push(`Liquidity down ${drop.toFixed(0)}% since entry`);
      else if (drop <= -10) positives.push(`Liquidity up ${(-drop).toFixed(0)}% since entry`);
    }
    if (i.positionValueUsd > 0) {
      const impact = constantProductImpactPct(i.positionValueUsd, s.liquidityUsd);
      if (impact >= 40) emergencyReasons.push(`Extreme execution risk: exiting would move price ${impact.toFixed(0)}%`);
      else if (impact >= 15) negatives.push(`High exit price impact (${impact.toFixed(0)}%)`);
    }
    if (i.safety && i.safety.criticalIssues.length) {
      for (const c of i.safety.criticalIssues) {
        // liquidity/pool/sim issues already reported above; surface any remaining critical security condition
        if (!/liquidity|pool|sell simulation/i.test(c)) emergencyReasons.push(`Critical condition: ${c}`);
      }
    }

    if (i.market) {
      if (i.market.buySellRatio >= 1.15) positives.push("Buy pressure is positive");
      else if (i.market.buySellRatio <= 0.75) negatives.push("Sell pressure dominates");
      if (i.market.volumeMomentum > 0.15) positives.push("Volume rising");
      else if (i.market.volumeMomentum < -0.4) negatives.push("Volume fading");
      if (i.market.liquidityTrend > 5) positives.push("Liquidity rising (1h)");
      else if (i.market.liquidityTrend < -15) negatives.push("Liquidity falling (1h)");
    }
    if (i.onchain) {
      if (i.onchain.holderGrowthPct1h > 0.5) positives.push("Holder count rising");
      else if (i.onchain.holderGrowthPct1h < -1) negatives.push("Holder count falling");
      if (i.onchain.whaleBias === "ACCUMULATION") positives.push("Large wallets accumulating");
      if (i.onchain.whaleBias === "DISTRIBUTION") negatives.push("Large wallets selling");
    }
  }

  const emergency = cfg.enabled && emergencyReasons.length > 0;
  let health: Health;
  if (emergencyReasons.length > 0) health = "EMERGENCY";
  else if (negatives.length >= 3 || (negatives.length >= 2 && positives.length === 0)) health = "WARNING";
  else if (negatives.length >= 1) health = "MONITOR";
  else health = "HOLD";
  return { health, emergency, emergencyReasons, positives, negatives };
}
