import { Keypair } from "@solana/web3.js";
import bs58 from "bs58";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import type { PrivateKeyAccount } from "viem";

/** The two address families a wallet can belong to: one Solana address, and one EVM address that works on every EVM chain. */
export type Family = "solana" | "evm";

/** A newly generated wallet: its public address and its secret as bytes (Solana: the 64-byte secret key; EVM: the 0x-prefixed hex key as text). */
export interface GeneratedWallet {
  address: string;
  /** the raw secret as bytes, ready to be sealed */
  secret: Buffer;
}

/** The secret as a wallet app accepts it for import: Solana wallets (Phantom, Solflare) take the 64-byte secret key in base58; EVM wallets take the hex private key. */
export function secretForExport(family: Family, secret: Buffer): string {
  return family === "evm" ? secret.toString("utf8") : bs58.encode(secret);
}

export function generateWallet(family: Family): GeneratedWallet {
  if (family === "evm") {
    const pk = generatePrivateKey();
    return { address: privateKeyToAccount(pk).address, secret: Buffer.from(pk, "utf8") };
  }
  const kp = Keypair.generate();
  return { address: kp.publicKey.toBase58(), secret: Buffer.from(kp.secretKey) };
}

export function solanaKeypair(secret: Buffer): Keypair {
  return Keypair.fromSecretKey(Uint8Array.from(secret));
}

export function evmAccount(secret: Buffer): PrivateKeyAccount {
  return privateKeyToAccount(secret.toString("utf8") as `0x${string}`);
}
