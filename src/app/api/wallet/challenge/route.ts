import { randomBytes } from "node:crypto";
import { SignJWT } from "jose";
import { z } from "zod";
import { parseBody, protectedRoute } from "@/lib/api";
import { env } from "@/lib/env";

const body = z.object({ family: z.enum(["solana", "evm"]), address: z.string().min(32).max(64) });

export const POST = protectedRoute(async ({ req, user }) => {
  const { family, address } = await parseBody(req, body);
  const message = `DEX Scout wallet verification\nAddress: ${address}\nNonce: ${randomBytes(12).toString("hex")}\nIssued: ${new Date().toISOString()}\nThis signature only proves ownership. It cannot move funds.`;
  const challenge = await new SignJWT({ address, family, message }).setProtectedHeader({ alg: "HS256" }).setSubject(user.id).setExpirationTime("5m").sign(new TextEncoder().encode(env().AUTH_SECRET));
  return { message, challenge };
});
