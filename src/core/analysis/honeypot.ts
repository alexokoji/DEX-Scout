import type { TokenSnapshot } from "../types";

/**
 * A cheap honeypot tell from trading flow, since selling for real can't be tried without owning the token: plenty of buys
 * and not a single sell in the last hour. It is a real signal on a young or shallow pool (buyers can't get out), but on an
 * established, deep pool a one-sided hour is ordinary (a stablecoin, a quiet blue chip), and blocking those was wrong.
 */
const MIN_BUYS = 20;
const DEEP_POOL_USD = 100_000;
const ESTABLISHED_HOURS = 24;

export function looksLikeHoneypotFlow(s: Pick<TokenSnapshot, "buys1h" | "sells1h" | "liquidityUsd" | "poolCreatedAt">, now = Date.now()): boolean {
  if (s.sells1h > 0 || s.buys1h < MIN_BUYS) return false;
  const ageHours = s.poolCreatedAt ? (now - new Date(s.poolCreatedAt).getTime()) / 3_600_000 : 0;
  const established = s.liquidityUsd >= DEEP_POOL_USD && ageHours >= ESTABLISHED_HOURS;
  return !established;
}
