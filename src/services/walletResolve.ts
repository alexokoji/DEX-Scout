import { CHAINS } from "@/core/chains";
import type { ChainId } from "@/core/types";
import { collections } from "@/lib/db";
import type { WalletDoc } from "@/lib/models";
import { TradeError } from "./errors";

/**
 * Which of a user's linked wallets a chain operation should use.
 *
 * The app used to take "the most recently linked wallet" for each address family. A user with more than one account
 * (a second MetaMask account, an older wallet, Phantom's Solana address next to MetaMask's) was then checked and traded
 * against an address that wasn't the one they had connected — a funded wallet read as $0.00. Now the browser says which
 * address it is connected with; it is used only if it is one of the user's verified wallets, and otherwise the user is
 * told to verify it (never silently swapped for a different one).
 */
export const walletFamilyOf = (chain: string): "evm" | "solana" => (CHAINS[chain as ChainId]?.family === "evm" ? "evm" : "solana");

const same = (family: "evm" | "solana", a: string, b: string) => (family === "evm" ? a.toLowerCase() === b.toLowerCase() : a === b);
export const shortAddress = (a: string) => (a.length > 12 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a);

/** All of the user's verified wallets of this family, best candidate first (most recently verified). */
export async function linkedWallets(userId: string, family: "evm" | "solana"): Promise<WalletDoc[]> {
  const docs = await (await collections.wallets()).find({ userId, chain: family }).toArray();
  return docs.sort((a, b) => (b.verifiedAt?.getTime() ?? 0) - (a.verifiedAt?.getTime() ?? 0) || b.createdAt.getTime() - a.createdAt.getTime());
}

/**
 * `requested` is the address the browser has connected. Returns that wallet if it is linked, throws a clear 409 if it is
 * not, and — only when nothing was requested (background jobs) — falls back to the most recently verified one.
 * null = the user has no wallet of this family linked at all.
 */
export async function resolveWallet(userId: string, chain: string, requested?: string | null): Promise<WalletDoc | null> {
  const family = walletFamilyOf(chain);
  const docs = await linkedWallets(userId, family);
  if (requested) {
    const hit = docs.find((w) => same(family, w.address, requested));
    if (hit) return hit;
    throw new TradeError(
      docs.length
        ? `The wallet you are connected with (${shortAddress(requested)}) isn't verified yet — you have ${docs.map((d) => shortAddress(d.address)).join(", ")} linked. Open Wallet and press "Verify & link" for the connected one, or switch to a linked account.`
        : `The wallet you are connected with (${shortAddress(requested)}) isn't verified yet. Open Wallet and press "Verify & link".`,
      409,
      [],
      { verify: family, address: requested },
    );
  }
  return docs[0] ?? null;
}

/** True when `address` is one of the user's linked wallets for the chain's family. */
export async function isLinkedWallet(userId: string, chain: string, address: string): Promise<boolean> {
  const family = walletFamilyOf(chain);
  return (await linkedWallets(userId, family)).some((w) => same(family, w.address, address));
}
