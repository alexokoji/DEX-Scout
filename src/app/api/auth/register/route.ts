import { NextResponse } from "next/server";
import { z } from "zod";
import { DEFAULT_FILTERS, DEFAULT_TARGETS_MULTI, DEFAULT_WEIGHTS } from "@/core/config";
import { errorResponse, parseBody } from "@/lib/api";
import { createSession, hashPassword } from "@/lib/auth";
import { db } from "@/lib/db";
import { logEvent } from "@/lib/events";
import { rateLimitAsync } from "@/lib/rateLimit";

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
    if (await db.user.findUnique({ where: { email: lower } })) {
      return NextResponse.json({ error: "An account with this email already exists" }, { status: 409 });
    }
    const user = await db.user.create({
      data: {
        email: lower,
        name,
        passwordHash: await hashPassword(password),
        settings: { create: { filters: JSON.parse(JSON.stringify(DEFAULT_FILTERS)), weights: JSON.parse(JSON.stringify(DEFAULT_WEIGHTS)), targets: { create: DEFAULT_TARGETS_MULTI } } },
        bot: { create: { status: "PAUSED", environment: "PAPER" } },
        tradingAccounts: { create: [{ environment: "PAPER" }] },
      },
    });
    await createSession(user.id);
    await logEvent({ type: "AUTH", source: "auth", userId: user.id, message: "Account created" });
    return NextResponse.json({ ok: true });
  } catch (e) {
    return errorResponse(e);
  }
}
