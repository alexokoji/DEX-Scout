import "dotenv/config";
import bcrypt from "bcryptjs";
import { DEFAULT_FILTERS, DEFAULT_TARGETS_MULTI, DEFAULT_WEIGHTS } from "../src/core/config";
import { closeDb, collections, newId } from "../src/lib/db";
import { env } from "../src/lib/env";

export const DEMO_EMAIL = "demo@dexscout.dev";
export const DEMO_PASSWORD = "demo-pass-123";

const json = <T,>(v: T) => JSON.parse(JSON.stringify(v));

/** Creates the local demo user (mock mode only) with default settings, a paused bot and a default strategy. */
async function main() {
  if (!env().MOCK_PROVIDER) {
    console.log("[seed] MOCK_PROVIDER is not true — skipping demo user");
    return;
  }
  const users = await collections.users();
  if (await users.findOne({ email: DEMO_EMAIL })) {
    console.log("[seed] demo user already exists");
    return;
  }

  const userId = newId();
  const now = new Date();
  await users.insertOne({ _id: userId, email: DEMO_EMAIL, name: "Demo Trader", passwordHash: await bcrypt.hash(DEMO_PASSWORD, 10), role: "USER", createdAt: now });

  const [settings, bots, accounts, strategies] = await Promise.all([
    collections.tradingSettings(),
    collections.bots(),
    collections.tradingAccounts(),
    collections.strategies(),
  ]);
  await Promise.all([
    settings.insertOne({
      _id: newId(), userId, environment: "PAPER", autoTradingEnabled: false, capitalUsd: 100, maxPositionUsd: 10, minPositionUsd: 5, maxOpenPositions: 10, maxDeployedUsd: 100,
      minOpportunityScore: 70, minLiquidityUsd: 100_000, minVolume24hUsd: 50_000, maxPriceImpactPct: 2, maxSlippageBps: 300, maxAllowedRisk: "MODERATE", targetsMode: "MULTI",
      maxPositionAgeHours: null, emergencyEnabled: true, emergencyAutoExit: false, emergencyLiquidityDropPct: 70,
      filters: json(DEFAULT_FILTERS), weights: json(DEFAULT_WEIGHTS), targets: DEFAULT_TARGETS_MULTI, activeStrategyId: null, updatedAt: now,
    }),
    bots.insertOne({ _id: newId(), userId, status: "PAUSED", environment: "PAPER", lastRunAt: null, emergencyStoppedAt: null, createdAt: now, updatedAt: now }),
    accounts.insertOne({ _id: newId(), userId, environment: "PAPER", realizedPnlUsd: 0, createdAt: now }),
    strategies.insertOne({
      _id: newId(), userId, name: "Default low-cap momentum",
      description: "Scanner filters, score weights and profit ladder shipped as defaults. Edit under Settings → Trading.",
      isDefault: true, config: json({ filters: DEFAULT_FILTERS, weights: DEFAULT_WEIGHTS, targets: DEFAULT_TARGETS_MULTI }), createdAt: now, updatedAt: now,
    }),
  ]);
  console.log(`[seed] created demo user ${DEMO_EMAIL} / ${DEMO_PASSWORD}`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => closeDb());
