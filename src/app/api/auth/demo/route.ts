import { NextResponse } from "next/server";
import { DEFAULT_FILTERS, DEFAULT_TARGETS_MULTI, DEFAULT_WEIGHTS } from "@/core/config";
import { errorResponse } from "@/lib/api";
import { createSession, hashPassword } from "@/lib/auth";
import { collections, newId, withId } from "@/lib/db";
import { env } from "@/lib/env";

/** One-click demo login. Only available when MOCK_PROVIDER=true — never in a real-data deployment. */
export async function POST() {
  try {
    if (!env().MOCK_PROVIDER) return NextResponse.json({ error: "Demo login is disabled" }, { status: 404 });
    const users = await collections.users();
    let user = await users.findOne({ email: "demo@dexscout.dev" });
    if (!user) {
      const userId = newId();
      const now = new Date();
      user = { _id: userId, email: "demo@dexscout.dev", name: "Demo Trader", passwordHash: await hashPassword("demo-pass-123"), role: "USER", createdAt: now };
      await users.insertOne(user);
      const [settings, bots, accounts] = await Promise.all([collections.tradingSettings(), collections.bots(), collections.tradingAccounts()]);
      await Promise.all([
        settings.insertOne({
          _id: newId(), userId, environment: "PAPER", autoTradingEnabled: false, capitalUsd: 100, maxPositionUsd: 10, minPositionUsd: 5, maxOpenPositions: 10, maxDeployedUsd: 100,
          minOpportunityScore: 70, minLiquidityUsd: 100_000, minVolume24hUsd: 50_000, maxPriceImpactPct: 2, maxSlippageBps: 300, maxAllowedRisk: "MODERATE", targetsMode: "MULTI",
          maxPositionAgeHours: null, emergencyEnabled: true, emergencyAutoExit: false, emergencyLiquidityDropPct: 70,
          filters: JSON.parse(JSON.stringify(DEFAULT_FILTERS)), weights: JSON.parse(JSON.stringify(DEFAULT_WEIGHTS)), targets: DEFAULT_TARGETS_MULTI, activeStrategyId: null, updatedAt: now,
        }),
        bots.insertOne({ _id: newId(), userId, status: "PAUSED", environment: "PAPER", lastRunAt: null, emergencyStoppedAt: null, createdAt: now, updatedAt: now }),
        accounts.insertOne({ _id: newId(), userId, environment: "PAPER", realizedPnlUsd: 0, createdAt: now }),
      ]);
    }
    await createSession(withId(user).id);
    return NextResponse.json({ ok: true });
  } catch (e) {
    return errorResponse(e);
  }
}
