import type { ProfitTargetConfig } from "../types";

export interface PositionState {
  entryPriceUsd: number;
  initialAmount: number;
  amount: number; // remaining tokens
  costBasisUsd: number; // cost of remaining tokens
  targetsHit: number;
}

export interface SellAction {
  level: number;
  gainPct: number;
  sellAmount: number;
  isFinal: boolean;
}

export function gainPct(entry: number, price: number): number {
  return entry > 0 ? (price / entry - 1) * 100 : 0;
}

export function normalizeTargets(targets: ProfitTargetConfig[]): ProfitTargetConfig[] {
  return [...targets].sort((a, b) => a.level - b.level);
}

/**
 * Profit-taking only. This function looks exclusively at price GAIN versus entry: a position that is
 * down 5/10/20% never produces an action here, by design (no default stop loss).
 * Each target sells `sellPct` of the INITIAL amount; the last target (or a 100% sell) sells whatever remains.
 * If price gaps over several targets in one tick, all crossed targets are returned in order.
 */
export function evaluateTargets(pos: PositionState, price: number, targets: ProfitTargetConfig[]): SellAction[] {
  const sorted = normalizeTargets(targets);
  if (!sorted.length || pos.amount <= 0) return [];
  const g = gainPct(pos.entryPriceUsd, price);
  const actions: SellAction[] = [];
  let remaining = pos.amount;
  for (let i = pos.targetsHit; i < sorted.length; i++) {
    const t = sorted[i];
    if (g + 1e-9 < t.gainPct) break; // epsilon: (1.4/1-1)*100 is 39.999...
    const isLast = i === sorted.length - 1;
    const wanted = (pos.initialAmount * t.sellPct) / 100;
    const sellAmount = isLast || t.sellPct >= 100 || wanted >= remaining ? remaining : wanted;
    const final = sellAmount >= remaining - 1e-12;
    actions.push({ level: t.level, gainPct: t.gainPct, sellAmount, isFinal: final });
    remaining -= sellAmount;
    if (final) break;
  }
  return actions;
}

/** Progress (0..1) toward the next unhit target; 1 when all are hit. */
export function targetProgress(entry: number, price: number, targets: ProfitTargetConfig[], hit: number) {
  const sorted = normalizeTargets(targets);
  const next = sorted[hit];
  if (!next) return { nextLevel: null as number | null, nextGainPct: null as number | null, progress: 1 };
  const g = gainPct(entry, price);
  return { nextLevel: next.level, nextGainPct: next.gainPct, progress: Math.min(1, Math.max(0, g / next.gainPct)) };
}

/** Validate a user-supplied target ladder: ascending gains, sensible percentages. */
export function validateTargets(targets: ProfitTargetConfig[]): string | null {
  if (!targets.length) return "At least one profit target is required";
  const sorted = normalizeTargets(targets);
  for (let i = 0; i < sorted.length; i++) {
    const t = sorted[i];
    if (t.gainPct <= 0) return "Target gains must be positive";
    if (t.sellPct <= 0 || t.sellPct > 100) return "Sell percentage must be between 0 and 100";
    if (i > 0 && t.gainPct <= sorted[i - 1].gainPct) return "Target gains must increase with each level";
  }
  return null;
}
