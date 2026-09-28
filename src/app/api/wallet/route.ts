import { z } from "zod";
import { jwtVerify } from "jose";
import { providers } from "@/core/providers/registry";
import { ApiError, parseBody, protectedRoute, serialize } from "@/lib/api";
import { collections, newId, withId, withIds } from "@/lib/db";
import { env } from "@/lib/env";
import { logEvent } from "@/lib/events";

export const GET = protectedRoute(async ({ user }) => {
  const wallets = await collections.wallets();
  return serialize(withIds(await wallets.find({ userId: user.id }).sort({ createdAt: -1 }).toArray()));
});

const link = z.object({ family: z.enum(["solana", "evm"]), address: z.string().min(32).max(64), challenge: z.string().min(10), signature: z.string().min(10) });

/**
 * Link a wallet after it proves ownership by signing a server-issued challenge (no keys ever leave the wallet).
 * Wallets are stored per address family: "solana", or "evm" (one address covers every EVM chain).
 */
export const POST = protectedRoute(async ({ req, user }) => {
  const { family, address: rawAddress, challenge, signature } = await parseBody(req, link);
  const address = family === "evm" ? rawAddress.toLowerCase() : rawAddress;
  let message: string;
  try {
    const { payload } = await jwtVerify(challenge, new TextEncoder().encode(env().AUTH_SECRET));
    if (payload.sub !== user.id || payload.address !== rawAddress || payload.family !== family || typeof payload.message !== "string") throw new Error("mismatch");
    message = payload.message;
  } catch {
    throw new ApiError("Challenge invalid or expired", 400);
  }
  const adapter = providers().chains[family === "evm" ? "ethereum" : "solana"];
  if (!adapter.isValidAddress(rawAddress)) throw new ApiError("Invalid address", 400);
  if (!providers().mock && !(await adapter.verifyMessageSignature(rawAddress, message, signature))) throw new ApiError("Signature verification failed", 400);
  const wallets = await collections.wallets();
  const existing = await wallets.findOne({ chain: family, address });
  if (existing && existing.userId !== user.id) throw new ApiError("Wallet is linked to another account", 409);
  const w = existing ?? (await (async () => {
    const doc = { _id: newId(), userId: user.id, address, chain: family, label: family === "evm" ? "EVM wallet" : "Solana wallet", verifiedAt: new Date(), createdAt: new Date() };
    await wallets.insertOne(doc);
    return doc;
  })());
  await logEvent({ type: "WALLET_LINKED", source: "wallet", userId: user.id, message: `${family === "evm" ? "EVM" : "Solana"} wallet ${address.slice(0, 6)}…${address.slice(-4)} linked` });
  return serialize(withId(w));
});
