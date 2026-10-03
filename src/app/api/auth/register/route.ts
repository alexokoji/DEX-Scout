import { NextResponse } from "next/server";
import { z } from "zod";
import { errorResponse, parseBody } from "@/lib/api";
import { createSession, hashPassword } from "@/lib/auth";
import { collections, newId } from "@/lib/db";
import { logEvent } from "@/lib/events";
import { rateLimitAsync } from "@/lib/rateLimit";
import { defaultSettingsDoc } from "@/services/settings";

const schema = z.object({
  email: z.string().email().max(200),
  password: z.string().min(10, "Password must be at least 10 characters").max(200),
  name: z.string().max(80).optional(),
});

export async function POST(req: Request) {
  try {
    const ip = req.headers.get("x-forwarded-for") ?? "local";
    if (!(await rateLimitAsync(`register:${ip}`, 5, 60_000)).ok) return NextResponse.json({ error: "Too many attempts" }, { status: 429 });
    const { email, password, name } = await parseBody(req, schema);
    const lower = email.toLowerCase();
    const users = await collections.users();
    if (await users.findOne({ email: lower })) {
      return NextResponse.json({ error: "An account with this email already exists" }, { status: 409 });
    }
    const userId = newId();
    const now = new Date();
    await users.insertOne({ _id: userId, email: lower, name: name ?? null, passwordHash: await hashPassword(password), role: "USER", createdAt: now });
    const [settings, bots, accounts] = await Promise.all([collections.tradingSettings(), collections.bots(), collections.tradingAccounts()]);
    await Promise.all([
      settings.insertOne(defaultSettingsDoc(userId, now)),
      bots.insertOne({ _id: newId(), userId, status: "PAUSED", environment: "LIVE", lastRunAt: null, emergencyStoppedAt: null, createdAt: now, updatedAt: now }),
      accounts.insertOne({ _id: newId(), userId, environment: "LIVE", realizedPnlUsd: 0, createdAt: now }),
    ]);
    await createSession(userId);
    await logEvent({ type: "AUTH", source: "auth", userId, message: "Account created" });
    return NextResponse.json({ ok: true });
  } catch (e) {
    return errorResponse(e);
  }
}
