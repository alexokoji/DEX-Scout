import { NextResponse } from "next/server";
import { z } from "zod";
import { errorResponse, parseBody } from "@/lib/api";
import { createSession, verifyPassword } from "@/lib/auth";
import { db } from "@/lib/db";
import { logEvent } from "@/lib/events";
import { rateLimitAsync } from "@/lib/rateLimit";

const schema = z.object({ email: z.string().email().max(200), password: z.string().min(1).max(200) });

export async function POST(req: Request) {
  try {
    const ip = req.headers.get("x-forwarded-for") ?? "local";
    const rl = await rateLimitAsync(`login:${ip}`, 10, 60_000);
    if (!rl.ok) return NextResponse.json({ error: "Too many attempts. Try again shortly." }, { status: 429 });
    const { email, password } = await parseBody(req, schema);
    const user = await db.user.findUnique({ where: { email: email.toLowerCase() } });
    // same message for unknown user and wrong password
    if (!user || !(await verifyPassword(password, user.passwordHash))) {
      return NextResponse.json({ error: "Invalid email or password" }, { status: 401 });
    }
    await createSession(user.id);
    await logEvent({ type: "AUTH", source: "auth", userId: user.id, message: "User signed in" });
    return NextResponse.json({ ok: true });
  } catch (e) {
    return errorResponse(e);
  }
}
