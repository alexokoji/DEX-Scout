import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

/**
 * Encryption of a bot wallet's secret key at rest. AES-256-GCM: the key is a 32-byte master key the operator puts in the server's
 * environment (never in the database, never sent to a browser); every secret gets its own random nonce, and the authentication tag
 * means a stored secret that was altered, or is opened with the wrong master key, fails to decrypt instead of yielding garbage.
 * Server-only.
 */
export interface SealedSecret {
  /** base64 */
  ciphertext: string;
  iv: string;
  tag: string;
}

/** The master key from its base64 form; throws a message that says what is wrong with it (it is operator configuration). */
export function parseMasterKey(b64: string | undefined): Buffer {
  if (!b64) throw new Error("BOT_WALLET_KEY is not set");
  const key = Buffer.from(b64, "base64");
  if (key.length !== 32) throw new Error(`BOT_WALLET_KEY must be 32 bytes encoded as base64 (got ${key.length}); generate one with: node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`);
  return key;
}

export function seal(secret: Uint8Array | string, masterKey: Buffer, aad: string): SealedSecret {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", masterKey, iv);
  cipher.setAAD(Buffer.from(aad)); // binds the secret to its owner and address: a sealed secret copied onto another wallet record won't open
  const ciphertext = Buffer.concat([cipher.update(typeof secret === "string" ? Buffer.from(secret, "utf8") : Buffer.from(secret)), cipher.final()]);
  return { ciphertext: ciphertext.toString("base64"), iv: iv.toString("base64"), tag: cipher.getAuthTag().toString("base64") };
}

export function open(sealed: SealedSecret, masterKey: Buffer, aad: string): Buffer {
  const decipher = createDecipheriv("aes-256-gcm", masterKey, Buffer.from(sealed.iv, "base64"));
  decipher.setAAD(Buffer.from(aad));
  decipher.setAuthTag(Buffer.from(sealed.tag, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(sealed.ciphertext, "base64")), decipher.final()]);
}
