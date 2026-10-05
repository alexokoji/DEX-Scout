import { CHAIN_IDS, CHAINS } from "@/core/chains";
import { withTimeout } from "@/core/providers/http";
import { providers } from "@/core/providers/registry";
import type { ChainId } from "@/core/types";
import { collections, withIds } from "@/lib/db";
import { usdBalance } from "@/lib/format";

const TTL_MS = 20_000;
/** SOL kept back on Solana: token-account rent (~0.00204) + fees + priority fee, with margin. */
export const SOLANA_RESERVE_SOL = 0.012;
const cache = new Map<string, { at: number; amount: number | null; px: number }>();

/** Native balance + USD price for one address on one chain; null amount = the RPC did not answer. Cached briefly so a page of stats isn't 20 RPC calls each time. */
async function nativeOn(chain: ChainId, address: string): Promise<{ amount: number | null; px: number }> {
  const key = `${chain}:${address}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return hit;
  const a = providers().chains[chain];
  const [amount, px] = await Promise.all([
    withTimeout(a.getNativeBalance(address), 6_000, `balance(${chain})`).catch(() => null),
    withTimeout(a.nativeUsdPrice(), 6_000, `price(${chain})`).catch(() => 0),
  ]);
  // don't cache a failure: the next call should try again
  if (amount !== null) cache.set(key, { at: Date.now(), amount, px });
  return { amount, px };
}

/** Native balances of every linked wallet: Solana wallets on Solana, EVM wallets on every EVM chain (or just `chains`). */
export async function walletBalances(userId: string, chains?: readonly ChainId[]) {
  const walletsCol = await collections.wallets();
  const wallets = withIds(await walletsCol.find({ userId }).sort({ createdAt: -1 }).toArray());
  const wanted = (c: ChainId) => !chains || chains.includes(c);
  const balances: { family: string; address: string; chain: string; symbol: string; amount: number; usd: number }[] = [];
  await Promise.all(
    wallets.flatMap((w) =>
      (w.chain === "evm" ? CHAIN_IDS.filter((c) => CHAINS[c].family === "evm") : (["solana"] as const)).filter(wanted).map(async (c) => {
        const { amount, px } = await nativeOn(c, w.address);
        if (amount !== null) balances.push({ family: w.chain, address: w.address, chain: c, symbol: CHAINS[c].nativeSymbol, amount, usd: amount * px });
      }),
    ),
  );
  balances.sort((x, y) => y.usd - x.usd);
  const totalUsd = balances.reduce((s, b) => s + b.usd, 0);
  // dollars first (that's what means something), the coin and chain after; dust and empty chains are left out
  const summary = balances.filter((b) => b.usd >= 0.01).slice(0, 4).map((b) => `${usdBalance(b.usd)} ${CHAINS[b.chain as ChainId].name}`).join(" · ");
  return { wallets: wallets.map((w) => ({ address: w.address, family: w.chain })), balances, totalUsd, summary };
}

/**
 * What the user's wallet can spend on `chain` right now, in USD: the native balance (swaps are paid in the native
 * token). null = no wallet linked for that chain family, or the RPC didn't answer — callers treat that as "unknown",
 * never as "zero".
 */
export interface Spendable {
  /** everything the wallet holds of the native coin on this chain, in USD */
  balanceUsd: number;
  /** kept back for network fees (and, on Solana, the new token account's deposit) */
  reserveUsd: number;
  /** what a swap can actually use */
  spendableUsd: number;
}

export async function spendableUsd(userId: string, chain: ChainId): Promise<number | null> {
  return (await spendableDetail(userId, chain))?.spendableUsd ?? null;
}

/** Same as spendableUsd, with the parts, so a message can say "you hold $X, $Y is kept for fees" instead of a bare "no balance". */
export async function spendableDetail(userId: string, chain: ChainId): Promise<Spendable | null> {
  const family = CHAINS[chain].family === "evm" ? "evm" : "solana";
  const wallets = await collections.wallets();
  const w = await wallets.findOne({ userId, chain: family }, { sort: { createdAt: -1 } });
  if (!w) return null;
  const { amount, px } = await nativeOn(chain, w.address);
  if (amount === null || !(px > 0)) return null;
  // A swap needs more than its own amount: network fees, priority fee and (Solana) the ~0.002 SOL deposit for a new token
  // account. Spending the whole balance fails in the wallet's simulation, so keep a little back.
  const balanceUsd = amount * px;
  // EVM: about one and a half swaps' worth of gas. (It used to be three, which on Ethereum is $12 and made a $10 balance read as empty.)
  const reserveUsd = chain === "solana" ? SOLANA_RESERVE_SOL * px : CHAINS[chain].typicalFeeUsd * 1.5;
  return { balanceUsd, reserveUsd, spendableUsd: Math.max(0, balanceUsd - reserveUsd) };
}
