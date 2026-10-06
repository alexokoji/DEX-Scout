/**
 * The chain side of getting token-account deposits back: find a wallet's empty token accounts, check each one can really be closed,
 * and build the (unsigned) transactions that close them. Nothing is signed or sent here; the owner's wallet signs.
 */
import { PublicKey } from "@solana/web3.js";
import { solanaTry } from "./solanaProviders";
import { buildCloseTransaction, closedAccounts, TOKEN_2022_PROGRAM, TOKEN_PROGRAM, type EmptyAccount } from "./tokenAccounts";

/** One transaction holds this many closes comfortably inside Solana's size limit. */
const PER_TRANSACTION = 10;
/** At most this many accounts are handled per request (the most valuable first); a wallet with more is done in rounds. */
const MAX_ACCOUNTS = 30;

/** Every token account of the wallet that holds none of its token (it is only holding a deposit) and isn't frozen. */
export async function emptyTokenAccounts(owner: string): Promise<EmptyAccount[]> {
  const o = new PublicKey(owner);
  const out: EmptyAccount[] = [];
  for (const program of [TOKEN_PROGRAM, TOKEN_2022_PROGRAM]) {
    const res = await solanaTry((c) => c.getParsedTokenAccountsByOwner(o, { programId: program }), 12_000);
    for (const a of res.value) {
      const info = (a.account.data as { parsed?: { info?: { mint?: string; state?: string; tokenAmount?: { amount?: string } } } }).parsed?.info;
      if (!info?.mint || info.state === "frozen" || info.tokenAmount?.amount !== "0") continue;
      out.push({ address: a.pubkey.toBase58(), mint: info.mint, program: program.toBase58(), lamports: a.account.lamports });
    }
  }
  return out.sort((a, b) => b.lamports - a.lamports);
}

/** Keeps the accounts the chain agrees can be closed: closing each is run against the chain first (a token with fees still held can't be closed). */
export async function closableAccounts(owner: string, accounts: EmptyAccount[]): Promise<EmptyAccount[]> {
  const o = new PublicKey(owner);
  const { blockhash } = await solanaTry((c) => c.getLatestBlockhash(), 8_000);
  const checked = await Promise.all(
    accounts.slice(0, MAX_ACCOUNTS).map(async (a) => {
      try {
        const res = await solanaTry((c) => c.simulateTransaction(buildCloseTransaction(o, [a], blockhash), { sigVerify: false, replaceRecentBlockhash: true, commitment: "processed" }), 8_000);
        return res.value.err ? null : a;
      } catch {
        return null;
      }
    }),
  );
  return checked.filter((a): a is EmptyAccount => !!a);
}

/** Unsigned transactions (base64) that close these accounts, a few per transaction. */
export async function closeTransactions(owner: string, accounts: EmptyAccount[]): Promise<{ transaction: string; accounts: number; lamports: number }[]> {
  const o = new PublicKey(owner);
  const { blockhash } = await solanaTry((c) => c.getLatestBlockhash(), 8_000);
  const out: { transaction: string; accounts: number; lamports: number }[] = [];
  for (let i = 0; i < accounts.length; i += PER_TRANSACTION) {
    const chunk = accounts.slice(i, i + PER_TRANSACTION);
    out.push({ transaction: Buffer.from(buildCloseTransaction(o, chunk, blockhash).serialize()).toString("base64"), accounts: chunk.length, lamports: chunk.reduce((s, a) => s + a.lamports, 0) });
  }
  return out;
}

export type ClosedByTransaction = { status: "CONFIRMED" | "PENDING" | "FAILED"; signer: string; closed: { mint: string; lamports: number }[] };

/** What a submitted close transaction did: still waiting, failed, or confirmed (and which accounts it closed, with the deposit each returned). */
export async function inspectClose(signature: string, owner: string): Promise<ClosedByTransaction> {
  const st = await solanaTry((c) => c.getSignatureStatuses([signature], { searchTransactionHistory: true }), 8_000);
  const s = st.value[0];
  if (!s) return { status: "PENDING", signer: "", closed: [] };
  if (s.err) return { status: "FAILED", signer: "", closed: [] };
  if (!s.confirmationStatus || s.confirmationStatus === "processed") return { status: "PENDING", signer: "", closed: [] };
  const tx = await solanaTry((c) => c.getParsedTransaction(signature, { maxSupportedTransactionVersion: 0, commitment: "confirmed" }), 12_000);
  if (!tx?.meta) return { status: "PENDING", signer: "", closed: [] };
  return { status: "CONFIRMED", signer: tx.transaction.message.accountKeys[0]?.pubkey.toBase58() ?? "", closed: closedAccounts(tx.meta, owner) };
}
