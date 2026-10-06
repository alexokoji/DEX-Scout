/**
 * Solana token accounts. A wallet holds each token in its own account, and the chain requires every account to hold a deposit
 * (rent-exempt minimum) for as long as it exists. The first buy of a token creates its account and locks that deposit; selling the
 * token empties the account but does not close it, so the deposit stays locked until the empty account is closed (which returns it).
 * Nothing here is a number we chose: how much a deposit is comes from the chain (the account's own balance), never from a constant.
 */
import { PublicKey, TransactionInstruction, TransactionMessage, VersionedTransaction } from "@solana/web3.js";

/** The two programs that own token accounts, and the one that derives a wallet's usual account for a token. These are fixed addresses on the chain. */
export const TOKEN_PROGRAM = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
export const TOKEN_2022_PROGRAM = new PublicKey("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");
export const ASSOCIATED_TOKEN_PROGRAM = new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");

/** The size in bytes of an ordinary token account (a fixed layout of the token program): the rent-exempt minimum is asked of the chain for this size. */
export const ACCOUNT_SIZE = 165;

/** The account a wallet normally holds a token in (the "associated" account), derived from the wallet, the token's program and the mint. */
export function associatedTokenAddress(owner: PublicKey, mint: PublicKey, tokenProgram: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync([owner.toBuffer(), tokenProgram.toBuffer(), mint.toBuffer()], ASSOCIATED_TOKEN_PROGRAM)[0];
}

/** "Close this empty token account and send what it holds to its owner." The token programs both take instruction 9 with these three accounts. */
export function closeAccountInstruction(account: PublicKey, owner: PublicKey, tokenProgram: PublicKey): TransactionInstruction {
  return new TransactionInstruction({
    programId: tokenProgram,
    keys: [
      { pubkey: account, isSigner: false, isWritable: true },
      { pubkey: owner, isSigner: false, isWritable: true }, // where the deposit goes
      { pubkey: owner, isSigner: true, isWritable: false }, // the authority that may close it
    ],
    data: Buffer.from([9]),
  });
}

export interface EmptyAccount {
  address: string;
  mint: string;
  program: string;
  /** the deposit it holds, in lamports: exactly what closing it returns */
  lamports: number;
}

/** An unsigned transaction that closes these accounts, for the owner's wallet to sign. */
export function buildCloseTransaction(owner: PublicKey, accounts: EmptyAccount[], recentBlockhash: string): VersionedTransaction {
  const message = new TransactionMessage({
    payerKey: owner,
    recentBlockhash,
    instructions: accounts.map((a) => closeAccountInstruction(new PublicKey(a.address), owner, new PublicKey(a.program))),
  }).compileToV0Message();
  return new VersionedTransaction(message);
}

/** The accounts of this wallet that a confirmed transaction closed, with the deposit each returned (so a refund can be attributed to its token). */
export function closedAccounts(meta: ParsedMeta & { preTokenBalances?: { accountIndex: number; owner?: string; mint?: string }[] | null }, owner: string): { mint: string; lamports: number }[] {
  const out: { mint: string; lamports: number }[] = [];
  for (const b of meta.preTokenBalances ?? []) {
    if (b.owner !== owner || !b.mint) continue;
    const pre = meta.preBalances[b.accountIndex] ?? 0;
    const post = meta.postBalances[b.accountIndex] ?? 0;
    if (pre > 0 && post === 0) out.push({ mint: b.mint, lamports: pre });
  }
  return out;
}

/** What one confirmed transaction did to a wallet's token-account deposits: lamports locked into accounts it opened, and returned from accounts it closed. */
export interface DepositChange {
  locked: number;
  returned: number;
}

interface ParsedMeta {
  preBalances: number[];
  postBalances: number[];
  preTokenBalances?: { accountIndex: number; owner?: string }[] | null;
  postTokenBalances?: { accountIndex: number; owner?: string }[] | null;
}

/**
 * Read it off the transaction itself: an account that went from nothing to holding a balance (and is one of the wallet's token
 * accounts) is a deposit locked; one that went from holding a balance to nothing is a deposit returned. An account opened and closed
 * inside the same swap (a temporary wrapped-SOL account) nets to nothing and is correctly not counted.
 */
export function depositChange(meta: ParsedMeta, owner: string): DepositChange {
  const mine = (arr: ParsedMeta["preTokenBalances"]) => new Set((arr ?? []).filter((b) => b.owner === owner).map((b) => b.accountIndex));
  const before = mine(meta.preTokenBalances);
  const after = mine(meta.postTokenBalances);
  let locked = 0;
  let returned = 0;
  for (const i of new Set([...before, ...after])) {
    const pre = meta.preBalances[i] ?? 0;
    const post = meta.postBalances[i] ?? 0;
    if (pre === 0 && post > 0 && after.has(i)) locked += post;
    else if (pre > 0 && post === 0 && before.has(i)) returned += pre;
  }
  return { locked, returned };
}
