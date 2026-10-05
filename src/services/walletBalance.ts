import { CHAIN_IDS, CHAINS } from "@/core/chains";
import { withTimeout } from "@/core/providers/http";
import { providers } from "@/core/providers/registry";
import type { ChainId } from "@/core/types";
import { collections, withIds } from "@/lib/db";
import type { SwapReserve } from "@/core/providers/interfaces";
import { usdBalance } from "@/lib/format";
import { resolveWallet } from "./walletResolve";

const TTL_MS = 20_000;
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
  /** the wallet address that was checked */
  address: string;
  /** everything the wallet holds of the native coin on this chain, in USD */
  balanceUsd: number;
  /** kept back for network fees (and, on Solana, the new token account's deposit) */
  reserveUsd: number;
  /** what the reserve consists of, in words, for messages */
  reserveNote: string;
  /** what a swap can actually use */
  spendableUsd: number;
}

export async function spendableUsd(userId: string, chain: ChainId, requested?: string | null, tokenAddress?: string): Promise<number | null> {
  return (await spendableDetail(userId, chain, requested, tokenAddress))?.spendableUsd ?? null;
}

/** Words for the reserve, from the measured parts: "network fee ~$0.01 + a one-time $0.18 deposit for the new token account (recoverable)". */
export function describeReserve(r: SwapReserve, px: number): string {
  const fee = `network fee ~${usdBalance(r.feesNative * px)}`;
  return r.depositNative > 0 ? `${fee}, plus a one-time ~${usdBalance(r.depositNative * px)} deposit for the new token account that you get back if you close it` : fee;
}

/**
 * Same as spendableUsd, with the parts, so a message can say "you hold $X, $Y is kept for fees" instead of a bare "no balance".
 *
 * The amount kept back is what the chain says a swap costs right now (the adapter reads it: Solana's base fee, priority
 * fee and token-account rent; an EVM chain's current gas price), for this wallet and token. If the chain's fees can't be
 * read, nothing is held back (unknown is not "expensive"); the swap dry-run before the wallet opens gives the exact answer.
 */
export async function spendableDetail(userId: string, chain: ChainId, requested?: string | null, tokenAddress?: string): Promise<Spendable | null> {
  // the wallet the browser is connected with if it is verified (a clear error if it is not), else the most recently verified one
  const w = await resolveWallet(userId, chain, requested);
  if (!w) return null;
  const { amount, px } = await nativeOn(chain, w.address);
  if (amount === null || !(px > 0)) return null;
  const balanceUsd = amount * px;
  const measured = await providers().chains[chain].estimateSwapReserve?.(w.address, tokenAddress).catch(() => null);
  const reserveUsd = measured ? measured.peakNative * px : 0;
  const reserveNote = measured ? describeReserve(measured, px) : "the network's fees couldn't be read just now";
  return { address: w.address, balanceUsd, reserveUsd, reserveNote, spendableUsd: Math.max(0, balanceUsd - reserveUsd) };
}
