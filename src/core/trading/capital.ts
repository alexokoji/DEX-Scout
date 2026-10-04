/**
 * Capital is whatever the user's connected wallet actually holds — there is no typed-in "trading capital" (that was a
 * leftover from demo trading, where the money was imaginary). The only user-set limits are per-trade size, the number
 * of open positions, and an optional cap on the total deployed.
 */
export interface CapitalSettings {
  maxPositionUsd: number;
  minPositionUsd: number;
  maxOpenPositions: number;
  /** optional ceiling on the cost basis of all open positions; null = limited only by the wallet balance */
  maxDeployedUsd: number | null;
}

export interface CapitalState {
  /** cost basis of all currently open positions */
  deployedUsd: number;
  openPositions: number;
  /**
   * What the wallet can spend, in USD (native balance on the chain being traded, or the total for display).
   * null/undefined = unknown (no wallet linked, or the RPC didn't answer): not enforced here, because the wallet
   * itself refuses an unaffordable transaction and an unreachable node must not block trading.
   */
  walletUsd?: number | null;
  /** realised P/L that has been added back to the capital pool (optional compounding) */
  realizedPnlUsd?: number;
}

export interface CapitalSnapshot {
  /** the wallet's balance, or null when unknown */
  walletUsd: number | null;
  deployedUsd: number;
  /** what can still be spent: the wallet balance, further limited by the optional deployed cap; null = unknown */
  availableUsd: number | null;
  openPositions: number;
  slotsLeft: number;
}

export function capitalSnapshot(s: CapitalSettings, st: CapitalState): CapitalSnapshot {
  const wallet = st.walletUsd ?? null;
  const capLeft = s.maxDeployedUsd === null ? null : Math.max(0, s.maxDeployedUsd - st.deployedUsd);
  const parts = [wallet, capLeft].filter((v): v is number => v !== null);
  return {
    walletUsd: wallet,
    deployedUsd: st.deployedUsd,
    availableUsd: parts.length ? Math.max(0, Math.min(...parts)) : null,
    openPositions: st.openPositions,
    slotsLeft: Math.max(0, s.maxOpenPositions - st.openPositions),
  };
}

export type AllocationResult = { ok: true; amountUsd: number } | { ok: false; reason: string };

/** Why nothing is available: an empty wallet and a hit deployed cap need different fixes. */
function noCapitalReason(s: CapitalSettings, st: CapitalState): string {
  if (st.walletUsd != null && st.walletUsd <= 0) return "Your wallet has no balance on this chain to trade with";
  if (s.maxDeployedUsd !== null && st.deployedUsd >= s.maxDeployedUsd) return `Maximum capital deployed reached ($${s.maxDeployedUsd})`;
  return "No available capital";
}

/**
 * Server-side allocation guard. Never trust the requested amount: it is clamped to every configured limit
 * and rejected if the clamped result would fall below the minimum position size.
 */
export function allocate(s: CapitalSettings, st: CapitalState, requestedUsd: number): AllocationResult {
  if (!Number.isFinite(requestedUsd) || requestedUsd <= 0) return { ok: false, reason: "Invalid amount" };
  const snap = capitalSnapshot(s, st);
  if (snap.slotsLeft <= 0) return { ok: false, reason: `Maximum open positions reached (${s.maxOpenPositions})` };
  if (snap.availableUsd !== null && snap.availableUsd <= 0) return { ok: false, reason: noCapitalReason(s, st) };
  const amount = Math.min(requestedUsd, s.maxPositionUsd, snap.availableUsd ?? Infinity);
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
  if (snap.availableUsd !== null && amountUsd > snap.availableUsd) {
    return st.walletUsd != null && amountUsd > st.walletUsd
      ? `Amount exceeds your wallet balance on this chain ($${st.walletUsd.toFixed(2)})`
      : `Amount exceeds available capital ($${snap.availableUsd.toFixed(2)})`;
  }
  return null;
}
