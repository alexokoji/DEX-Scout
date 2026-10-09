/**
 * Signing for the bot wallet on Solana. The bot wallet is a wallet whose key the server holds (see core/botwallet), so unlike every other
 * path in this app the server signs here. It signs only transactions paid for by that wallet, and records the signature BEFORE sending,
 * so a transaction that lands is never untracked.
 */
import { Keypair, PublicKey, SystemProgram, TransactionMessage, VersionedTransaction } from "@solana/web3.js";
import bs58 from "bs58";

export interface SignedSolana {
  signedB64: string;
  /** the transaction's signature (its id on the chain), known before it is sent */
  signature: string;
}

/** Signs a prepared (unsigned) transaction with the bot wallet's key. Refuses a transaction this wallet isn't the fee payer of. */
export function signSolanaTransaction(unsignedB64: string, keypair: Keypair): SignedSolana {
  const tx = VersionedTransaction.deserialize(Buffer.from(unsignedB64, "base64"));
  if (!tx.message.staticAccountKeys[0]?.equals(keypair.publicKey)) throw new Error("This transaction is not paid for by the bot wallet, so it is not signed");
  tx.sign([keypair]);
  return { signedB64: Buffer.from(tx.serialize()).toString("base64"), signature: bs58.encode(tx.signatures[0]) };
}

/** An unsigned transfer of native SOL (the withdraw path). */
export function buildSolTransfer(from: PublicKey, to: PublicKey, lamports: number, recentBlockhash: string): VersionedTransaction {
  return new VersionedTransaction(new TransactionMessage({ payerKey: from, recentBlockhash, instructions: [SystemProgram.transfer({ fromPubkey: from, toPubkey: to, lamports })] }).compileToV0Message());
}
