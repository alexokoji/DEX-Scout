import { closableAccounts, closeTransactions, emptyTokenAccounts, inspectClose } from "@/core/providers/solana/reclaim";
import { providers } from "@/core/providers/registry";
import { collections, newId } from "@/lib/db";
import { TradeError } from "./errors";
import { resolveWallet } from "./walletResolve";

/**
 * Getting the deposits back. The first time a Solana wallet holds a token, the chain opens a token account for it and locks a deposit
 * in it; selling the token empties that account but doesn't close it, so the deposit stays locked until the empty account is closed.
 * Closing returns the whole deposit. These find the wallet's empty accounts, build the (unsigned) transaction that closes them for the
 * wallet to sign, and, once it has confirmed, put the refund against the position it came from.
 */

async function solanaWallet(userId: string, requested?: string | null): Promise<string> {
  const w = await resolveWallet(userId, "solana", requested);
  if (!w) throw new TradeError("Connect and verify a Solana wallet first", 400);
  return w.address;
}

/** The empty token accounts of the user's Solana wallet and what closing them returns. */
export async function reclaimable(userId: string, requested?: string | null) {
  if (providers().mock) return { wallet: null as string | null, accounts: [], totalUsd: 0, totalNative: 0 };
  const wallet = await solanaWallet(userId, requested);
  const usable = await closableAccounts(wallet, await emptyTokenAccounts(wallet));
  const px = await providers().chains.solana.nativeUsdPrice();
  const tokens = usable.length ? await (await collections.tokens()).find({ chain: "solana", address: { $in: usable.map((a) => a.mint) } }, { projection: { address: 1, symbol: 1 } }).toArray() : [];
  const symbol = new Map(tokens.map((t) => [t.address, t.symbol]));
  const accounts = usable.map((a) => ({ address: a.address, mint: a.mint, symbol: symbol.get(a.mint) ?? null, native: a.lamports / 1e9, usd: (a.lamports / 1e9) * px }));
  const totalNative = accounts.reduce((s, a) => s + a.native, 0);
  return { wallet, accounts, totalUsd: totalNative * px, totalNative };
}

/** Unsigned transactions that close every empty account the chain agrees can be closed. */
export async function buildReclaim(userId: string, requested?: string | null) {
  const wallet = await solanaWallet(userId, requested);
  const usable = await closableAccounts(wallet, await emptyTokenAccounts(wallet));
  if (!usable.length) throw new TradeError("There are no empty token accounts to close", 409);
  return { wallet, transactions: await closeTransactions(wallet, usable) };
}

/**
 * The wallet signed and sent a close: wait (briefly) for the chain to confirm it, then put what it returned against the position
 * whose first buy opened each account, so that position's wallet result no longer counts the deposit as lost.
 */
export async function confirmReclaim(userId: string, signature: string, requested?: string | null) {
  const wallet = await solanaWallet(userId, requested);
  let r = await inspectClose(signature, wallet);
  for (let i = 0; i < 8 && r.status === "PENDING"; i++) {
    await new Promise((res) => setTimeout(res, 2_500));
    r = await inspectClose(signature, wallet);
  }
  if (r.status === "FAILED") throw new TradeError("The transaction failed on-chain, so nothing was closed", 422);
  if (r.status === "PENDING") return { status: "PENDING" as const, refundUsd: 0 };
  if (r.signer !== wallet) throw new TradeError("That transaction was not signed by your linked wallet", 403);

  const px = await providers().chains.solana.nativeUsdPrice();
  const events = await collections.positionEvents();
  const trades = await collections.trades();
  const tokens = await collections.tokens();
  let refundLamports = 0;
  for (const c of r.closed) {
    refundLamports += c.lamports;
    const token = await tokens.findOne({ chain: "solana", address: c.mint }, { projection: { _id: 1 } });
    if (!token) continue;
    // the position whose buy opened this account: the latest of the user's trades in this token that locked a deposit
    const opener = await trades.find({ userId, tokenId: token._id, status: "CONFIRMED", "walletChange.depositNative": { $gt: 0 }, positionId: { $ne: null } }).sort({ createdAt: -1 }).limit(1).toArray();
    const positionId = opener[0]?.positionId;
    if (!positionId) continue;
    if (await events.findOne({ positionId, type: "DEPOSIT_RECLAIMED", "data.signature": signature, "data.mint": c.mint })) continue;
    await events.insertOne({
      _id: newId(),
      positionId,
      type: "DEPOSIT_RECLAIMED",
      message: `Token-account deposit returned to your wallet: ${(c.lamports / 1e9).toFixed(6)} SOL`,
      data: { signature, mint: c.mint, refundNative: c.lamports / 1e9, nativeUsd: px },
      createdAt: new Date(),
    });
  }
  return { status: "CONFIRMED" as const, closed: r.closed.length, refundUsd: (refundLamports / 1e9) * px };
}
