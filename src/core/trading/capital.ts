export interface CapitalSettings {
  capitalUsd: number;
  maxPositionUsd: number;
  minPositionUsd: number;
  maxOpenPositions: number;
  maxDeployedUsd: number;
}

export interface CapitalState {
  /** cost basis of all currently open positions */
  deployedUsd: number;
  openPositions: number;
  /** realised P/L that has been added back to the capital pool (optional compounding) */
  realizedPnlUsd?: number;
}

export interface CapitalSnapshot {
  capitalUsd: number;
  deployedUsd: number;
  availableUsd: number;
  openPositions: number;
  slotsLeft: number;
}

/** The deployable ceiling is the lesser of the trading capital and the explicit max-deployed cap. */
export function capitalSnapshot(s: CapitalSettings, st: CapitalState): CapitalSnapshot {
  const ceiling = Math.min(s.capitalUsd, s.maxDeployedUsd);
  return {
    capitalUsd: s.capitalUsd,
    deployedUsd: st.deployedUsd,
    availableUsd: Math.max(0, ceiling - st.deployedUsd),
    openPositions: st.openPositions,
    slotsLeft: Math.max(0, s.maxOpenPositions - st.openPositions),
  };
}

export type AllocationResult = { ok: true; amountUsd: number } | { ok: false; reason: string };

/**
 * Server-side allocation guard. Never trust the requested amount: it is clamped to every configured limit
 * and rejected if the clamped result would fall below the minimum position size.
 */
export function allocate(s: CapitalSettings, st: CapitalState, requestedUsd: number): AllocationResult {
  if (!Number.isFinite(requestedUsd) || requestedUsd <= 0) return { ok: false, reason: "Invalid amount" };
  const snap = capitalSnapshot(s, st);
  if (snap.slotsLeft <= 0) return { ok: false, reason: `Maximum open positions reached (${s.maxOpenPositions})` };
  if (snap.availableUsd <= 0) return { ok: false, reason: "No available capital" };
  const amount = Math.min(requestedUsd, s.maxPositionUsd, snap.availableUsd);
  if (amount < s.minPositionUsd) {
    return { ok: false, reason: `Allowed amount $${amount.toFixed(2)} is below minimum position $${s.minPositionUsd}` };
  }
  return { ok: true, amountUsd: Math.round(amount * 100) / 100 };
}

/** For manual trades the user picks the amount; it must fit the limits exactly (no silent shrinking). */
export function checkManualAmount(s: CapitalSettings, st: CapitalState, amountUsd: number): string | null {
  if (!Number.isFinite(amountUsd) || amountUsd <= 0) return "Invalid amount";
  const snap = capitalSnapshot(s, st);
  if (snap.slotsLeft <= 0) return `Maximum open positions reached (${s.maxOpenPositions})`;
  if (amountUsd > s.maxPositionUsd) return `Amount exceeds maximum position size ($${s.maxPositionUsd})`;
  if (amountUsd < s.minPositionUsd) return `Amount is below minimum position size ($${s.minPositionUsd})`;
  if (amountUsd > snap.availableUsd) return `Amount exceeds available capital ($${snap.availableUsd.toFixed(2)})`;
  return null;
}
