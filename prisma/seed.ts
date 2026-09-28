import "dotenv/config";
import { PrismaClient } from "@prisma/client";
import bcrypt from "bcryptjs";

const json = <T,>(v: T) => JSON.parse(JSON.stringify(v));
import { DEFAULT_FILTERS, DEFAULT_TARGETS_MULTI, DEFAULT_WEIGHTS } from "../src/core/config";

const db = new PrismaClient();

export const DEMO_EMAIL = "demo@dexscout.dev";
export const DEMO_PASSWORD = "demo-pass-123";

/** Creates the local demo user (mock mode only) with default settings, a paused bot and a default strategy. */
async function main() {
  if (process.env.MOCK_PROVIDER !== "true") {
    console.log("[seed] MOCK_PROVIDER is not true — skipping demo user");
    return;
  }
  const existing = await db.user.findUnique({ where: { email: DEMO_EMAIL } });
  if (existing) {
    console.log("[seed] demo user already exists");
    return;
  }
  const user = await db.user.create({
    data: {
      email: DEMO_EMAIL,
      name: "Demo Trader",
      passwordHash: await bcrypt.hash(DEMO_PASSWORD, 10),
      settings: {
        create: {
          environment: "PAPER",
          filters: json(DEFAULT_FILTERS),
          weights: json(DEFAULT_WEIGHTS),
          targets: { create: DEFAULT_TARGETS_MULTI },
        },
      },
      bot: { create: { status: "PAUSED", environment: "PAPER" } },
      tradingAccounts: { create: [{ environment: "PAPER" }] },
      strategies: {
        create: {
          name: "Default low-cap momentum",
          description: "Scanner filters, score weights and profit ladder shipped as defaults. Edit under Settings → Trading.",
          isDefault: true,
          config: json({ filters: DEFAULT_FILTERS, weights: DEFAULT_WEIGHTS, targets: DEFAULT_TARGETS_MULTI }),
        },
      },
    },
  });
  console.log(`[seed] created demo user ${user.email} / ${DEMO_PASSWORD}`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => db.$disconnect());
