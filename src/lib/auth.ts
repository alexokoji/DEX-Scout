import bcrypt from "bcryptjs";
import { SignJWT, jwtVerify } from "jose";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { cache } from "react";
import { collections, withId } from "./db";
import { env } from "./env";

const COOKIE = "dexscout_session";
const MAX_AGE_SEC = 60 * 60 * 24 * 7;

const key = () => new TextEncoder().encode(env().AUTH_SECRET);

export async function hashPassword(pw: string) {
  return bcrypt.hash(pw, 10);
}
export async function verifyPassword(pw: string, hash: string) {
  return bcrypt.compare(pw, hash);
}

export async function createSession(userId: string) {
  const token = await new SignJWT({ sub: userId })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime(`${MAX_AGE_SEC}s`)
    .sign(key());
  (await cookies()).set(COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: MAX_AGE_SEC,
  });
}

export async function destroySession() {
  (await cookies()).delete(COOKIE);
}

/** Resolve the signed-in user from the session cookie (server-side only). Returns null if unauthenticated. */
export const currentUser = cache(async () => {
  const token = (await cookies()).get(COOKIE)?.value;
  if (!token) return null;
  try {
    const { payload } = await jwtVerify(token, key());
    if (!payload.sub) return null;
    const users = await collections.users();
    const u = await users.findOne({ _id: payload.sub });
    if (!u) return null;
    const { id, email, name, role } = withId(u);
    return { id, email, name, role };
  } catch {
    return null;
  }
});

/** For server components / pages. */
export async function requireUser() {
  const u = await currentUser();
  if (!u) redirect("/login");
  return u;
}
