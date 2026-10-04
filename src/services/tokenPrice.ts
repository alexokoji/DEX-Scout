import { withTimeout } from "@/core/providers/http";
import { providers } from "@/core/providers/registry";
import type { ChainId, TokenSnapshot } from "@/core/types";
import { collections } from "@/lib/db";

/**
 * Write a live snapshot's market fields onto the token row (price, cap, liquidity, volume, momentum) and stamp
 * `lastScannedAt`. Deliberately does not touch stage / passedFilters / analysis: this only keeps what is displayed true.
 */
export async function applyLiveSnapshot(tokenId: string, s: TokenSnapshot): Promise<void> {
  const tx1h = s.buys1h + s.sells1h;
  const now = new Date();
  await (await collections.tokens()).updateOne(
    { _id: tokenId },
    {
      $set: {
        priceUsd: s.priceUsd,
        marketCapUsd: s.marketCapUsd,
        fdvUsd: s.fdvUsd,
        liquidityUsd: s.liquidityUsd,
        volume24hUsd: s.volume24h,
        volume1hUsd: s.volume1h,
        change5m: s.change5m,
        change1h: s.change1h,
        change24h: s.change24h,
        buySellRatio: s.sells1h === 0 ? (s.buys1h > 0 ? 3 : 1) : s.buys1h / s.sells1h,
        txCount1h: tx1h,
        lastScannedAt: now,
        updatedAt: now,
      },
    },
  );
}

/**
 * Make sure the price about to be shown (a token page someone opened, a token they may buy) is live: if the stored one
 * is older than `maxAgeMs`, fetch it now. One DexScreener request, bounded to 5s; on any failure the stored price is
 * kept and the caller shows its real age. Returns whether it was refreshed.
 */
export async function refreshTokenIfStale(token: { id: string; chain: string; address: string; lastScannedAt: Date | null }, maxAgeMs = 60_000): Promise<boolean> {
  if (token.lastScannedAt && Date.now() - new Date(token.lastScannedAt).getTime() < maxAgeMs) return false;
  const p = providers();
  const chain = token.chain as ChainId;
  try {
    const snap = p.data.refresh ? (await withTimeout(p.data.refresh(chain, [token.address]), 5_000, "price refresh"))[0] : await withTimeout(p.data.getSnapshot(chain, token.address), 5_000, "price refresh");
    if (!snap || !(snap.priceUsd > 0)) return false;
    await applyLiveSnapshot(token.id, snap);
    return true;
  } catch {
    return false;
  }
}
