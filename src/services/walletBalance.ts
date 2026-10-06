import { CHAIN_IDS, CHAINS } from "@/core/chains";
import { withTimeout } from "@/core/providers/http";
import { providers } from "@/core/providers/registry";
import type { ChainId } from "@/core/types";
import { collections, withIds } from "@/lib/db";
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
 * What the user's wallet holds on `chain` right now, in USD. null = no wallet linked for that chain family, or the RPC didn't
 * answer: callers treat that as "unknown", never as "zero".
 *
 * This is the whole balance. No amount is subtracted for fees: working out what a swap will cost and keeping that back was an
 * estimate (and every estimate needs a margin, which is a made-up number). Whether the wallet can afford a particular swap is
 * answered by the chain itself when the swap is prepared: Solana's node simulates the exact transaction, and for EVM the node's
 * own gas estimate for it is set against the balance (see each adapter's preflight), both with the real figures in the message.
 */
export interface Spendable {
  /** the wallet address that was checked */
  address: string;
  /** everything the wallet holds of the native coin on this chain, in USD */
  balanceUsd: number;
}

export async function spendableUsd(userId: string, chain: ChainId, requested?: string | null): Promise<number | null> {
  return (await spendableDetail(userId, chain, requested))?.balanceUsd ?? null;
}

export async function spendableDetail(userId: string, chain: ChainId, requested?: string | null): Promise<Spendable | null> {
  // the wallet the browser is connected with if it is verified (a clear error if it is not), else the most recently verified one
  const w = await resolveWallet(userId, chain, requested);
  if (!w) return null;
  const { amount, px } = await nativeOn(chain, w.address);
  if (amount === null || !(px > 0)) return null;
  return { address: w.address, balanceUsd: amount * px };
}