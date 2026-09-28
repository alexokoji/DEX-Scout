import type { Environment, Prisma, RiskLevel, TargetsMode } from "@prisma/client";
import { z } from "zod";
import {
  DEFAULT_TARGETS_MULTI,
  DEFAULT_TARGETS_SINGLE,
  scannerFiltersSchema,
  scoreWeightsSchema,
} from "@/core/config";
import type { ProfitTargetConfig, ScannerFilters, ScoreWeights } from "@/core/types";
import { validateTargets } from "@/core/trading/targets";
import { db } from "@/lib/db";
import { logEvent } from "@/lib/events";

export const tradingSettingsInput = z
  .object({
    environment: z.enum(["MANUAL", "PAPER", "LIVE"]),
    autoTradingEnabled: z.boolean(),
    capitalUsd: z.number().positive().max(10_000_000),
    maxPositionUsd: z.number().positive(),
    minPositionUsd: z.number().min(0),
    maxOpenPositions: z.number().int().min(1).max(500),
    maxDeployedUsd: z.number().positive(),
    minOpportunityScore: z.number().min(0).max(100),
    minLiquidityUsd: z.number().min(0),
    minVolume24hUsd: z.number().min(0),
    maxPriceImpactPct: z.number().min(0.01).max(50),
    maxSlippageBps: z.number().int().min(1).max(5000),
    maxAllowedRisk: z.enum(["LOWER", "MODERATE", "HIGH"]),
    targetsMode: z.enum(["SINGLE", "MULTI"]),
    maxPositionAgeHours: z.number().int().min(1).nullable(),
    emergencyEnabled: z.boolean(),
    emergencyAutoExit: z.boolean(),
    emergencyLiquidityDropPct: z.number().min(10).max(99),
    filters: scannerFiltersSchema,
    weights: scoreWeightsSchema,
    targets: z
      .array(z.object({ level: z.number().int().min(1).max(10), gainPct: z.number(), sellPct: z.number() }))
      .min(1)
      .max(10),
  })
  .superRefine((v, ctx) => {
    if (v.minPositionUsd > v.maxPositionUsd) ctx.addIssue({ code: "custom", path: ["minPositionUsd"], message: "Minimum position exceeds maximum" });
    if (v.maxPositionUsd > v.capitalUsd) ctx.addIssue({ code: "custom", path: ["maxPositionUsd"], message: "Maximum position exceeds trading capital" });
    if (v.maxDeployedUsd > v.capitalUsd) ctx.addIssue({ code: "custom", path: ["maxDeployedUsd"], message: "Maximum deployed exceeds trading capital" });
    if (v.filters.minMarketCapUsd > v.filters.maxMarketCapUsd) ctx.addIssue({ code: "custom", path: ["filters", "minMarketCapUsd"], message: "Min market cap exceeds max" });
    const err = validateTargets(v.targets);
    if (err) ctx.addIssue({ code: "custom", path: ["targets"], message: err });
  });

export type TradingSettingsInput = z.infer<typeof tradingSettingsInput>;

export interface UserSettings {
  id: string;
  userId: string;
  environment: Environment;
  autoTradingEnabled: boolean;
  capitalUsd: number;
  maxPositionUsd: number;
  minPositionUsd: number;
  maxOpenPositions: number;
  maxDeployedUsd: number;
  minOpportunityScore: number;
  minLiquidityUsd: number;
  minVolume24hUsd: number;
  maxPriceImpactPct: number;
  maxSlippageBps: number;
  maxAllowedRisk: RiskLevel;
  targetsMode: TargetsMode;
  maxPositionAgeHours: number | null;
  emergencyEnabled: boolean;
  emergencyAutoExit: boolean;
  emergencyLiquidityDropPct: number;
  filters: ScannerFilters;
  weights: ScoreWeights;
  targets: ProfitTargetConfig[];
}

function hydrate(row: Prisma.TradingSettingsGetPayload<{ include: { targets: true } }>): UserSettings {
  const targets = row.targets
    .map((t) => ({ level: t.level, gainPct: t.gainPct, sellPct: t.sellPct }))
    .sort((a, b) => a.level - b.level);
  return {
    ...row,
    filters: scannerFiltersSchema.parse(row.filters ?? {}),
    weights: scoreWeightsSchema.parse(row.weights ?? {}),
    targets: targets.length ? targets : row.targetsMode === "SINGLE" ? DEFAULT_TARGETS_SINGLE : DEFAULT_TARGETS_MULTI,
    maxPositionAgeHours: row.maxPositionAgeHours,
  };
}

export async function getSettings(userId: string): Promise<UserSettings> {
  const existing = await db.tradingSettings.findUnique({ where: { userId }, include: { targets: true } });
  if (existing) return hydrate(existing);
  const created = await db.tradingSettings.create({
    data: {
      userId,
      filters: scannerFiltersSchema.parse({}),
      weights: scoreWeightsSchema.parse({}),
      targets: { create: DEFAULT_TARGETS_MULTI },
    },
    include: { targets: true },
  });
  return hydrate(created);
}

export async function updateSettings(userId: string, input: TradingSettingsInput): Promise<UserSettings> {
  const { targets, filters, weights, ...rest } = input;
  await getSettings(userId); // ensure row
  const row = await db.$transaction(async (tx) => {
    const cur = await tx.tradingSettings.findUniqueOrThrow({ where: { userId } });
    await tx.profitTarget.deleteMany({ where: { settingsId: cur.id } });
    return tx.tradingSettings.update({
      where: { userId },
      data: { ...rest, filters, weights, targets: { create: targets } },
      include: { targets: true },
    });
  });
  await logEvent({ type: "SETTINGS_UPDATED", source: "settings", userId, message: "Trading settings updated", data: { environment: input.environment, autoTradingEnabled: input.autoTradingEnabled } });
  return hydrate(row);
}

export async function allUserFilters(): Promise<ScannerFilters[]> {
  const rows = await db.tradingSettings.findMany({ select: { filters: true } });
  return rows.map((r) => scannerFiltersSchema.parse(r.filters ?? {}));
}
