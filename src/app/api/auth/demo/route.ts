import { NextResponse } from "next/server";
import { DEFAULT_FILTERS, DEFAULT_TARGETS_MULTI, DEFAULT_WEIGHTS } from "@/core/config";
import { errorResponse } from "@/lib/api";
import { createSession, hashPassword } from "@/lib/auth";
import { db } from "@/lib/db";
import { env } from "@/lib/env";

/** One-click demo login. Only available when MOCK_PROVIDER=true — never in a real-data deployment. */
export async function POST() {
  try {
    if (!env().MOCK_PROVIDER) return NextResponse.json({ error: "Demo login is disabled" }, { status: 404 });
    let user = await db.user.findUnique({ where: { email: "demo@dexscout.dev" } });
    if (!user) {
      user = await db.user.create({
        data: {
          email: "demo@dexscout.dev",
          name: "Demo Trader",
          passwordHash: await hashPassword("demo-pass-123"),
          settings: { create: { filters: JSON.parse(JSON.stringify(DEFAULT_FILTERS)), weights: JSON.parse(JSON.stringify(DEFAULT_WEIGHTS)), targets: { create: DEFAULT_TARGETS_MULTI } } },
          bot: { create: { status: "PAUSED", environment: "PAPER" } },
          tradingAccounts: { create: [{ environment: "PAPER" }] },
        },
      });
    }
    await createSession(user.id);
    return NextResponse.json({ ok: true });
  } catch (e) {
    return errorResponse(e);
  }
}
