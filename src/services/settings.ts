import { z } from "zod";
import {
  DEFAULT_TARGETS_MULTI,
  DEFAULT_TARGETS_SINGLE,
  scannerFiltersSchema,
  scoreWeightsSchema,
} from "@/core/config";
import type { ProfitTargetConfig, ScannerFilters, ScoreWeights } from "@/core/types";
import { validateTargets } from "@/core/trading/targets";
import { collections, newId, withId } from "@/lib/db";
import { logEvent } from "@/lib/events";
import type { Environment, RiskLevel, TargetsMode, TradingSettingsDoc } from "@/lib/models";

export const tradingSettingsInput = z
  .object({
    environment: z.enum(["MANUAL", "LIVE"]),
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

function hydrate(row: TradingSettingsDoc): UserSettings {
  const targets = [...(row.targets ?? [])].sort((a, b) => a.level - b.level);
  const { id, ...rest } = withId(row);
  return {
    id,
    ...rest,
    filters: scannerFiltersSchema.parse(row.filters ?? {}),
    weights: scoreWeightsSchema.parse(row.weights ?? {}),
    targets: targets.length ? targets : row.targetsMode === "SINGLE" ? DEFAULT_TARGETS_SINGLE : DEFAULT_TARGETS_MULTI,
  };
}

export async function getSettings(userId: string): Promise<UserSettings> {
  const col = await collections.tradingSettings();
  const existing = await col.findOne({ userId });
  if (existing) return hydrate(existing);
  const doc: TradingSettingsDoc = {
    _id: newId(),
    userId,
    environment: "MANUAL",
    autoTradingEnabled: false,
    capitalUsd: 100,
    maxPositionUsd: 10,
    minPositionUsd: 5,
    maxOpenPositions: 10,
    maxDeployedUsd: 100,
    minOpportunityScore: 70,
    minLiquidityUsd: 100_000,
    minVolume24hUsd: 50_000,
    maxPriceImpactPct: 2,
    maxSlippageBps: 300,
    maxAllowedRisk: "MODERATE",
    targetsMode: "MULTI",
    maxPositionAgeHours: null,
    emergencyEnabled: true,
    emergencyAutoExit: false,
    emergencyLiquidityDropPct: 70,
    filters: scannerFiltersSchema.parse({}),
    weights: scoreWeightsSchema.parse({}),
    targets: DEFAULT_TARGETS_MULTI,
    activeStrategyId: null,
    updatedAt: new Date(),
  };
  try {
    await col.insertOne(doc);
  } catch (err) {
    // a concurrent request created it first (unique index on userId) — just read what's there
    if (!(err instanceof Error) || !("code" in err) || (err as { code?: number }).code !== 11000) throw err;
    const raced = await col.findOne({ userId });
    if (!raced) throw err;
    return hydrate(raced);
  }
  return hydrate(doc);
}

export async function updateSettings(userId: string, input: TradingSettingsInput): Promise<UserSettings> {
  await getSettings(userId); // ensure a row exists
  const col = await collections.tradingSettings();
  const { targets, filters, weights, ...rest } = input;
  await col.updateOne({ userId }, { $set: { ...rest, filters, weights, targets, updatedAt: new Date() } });
  const row = await col.findOne({ userId });
  if (!row) throw new Error("Trading settings disappeared during update");
  await logEvent({ type: "SETTINGS_UPDATED", source: "settings", userId, message: "Trading settings updated", data: { environment: input.environment, autoTradingEnabled: input.autoTradingEnabled } });
  return hydrate(row);
}

export async function allUserFilters(): Promise<ScannerFilters[]> {
  const col = await collections.tradingSettings();
  const rows = await col.find({}, { projection: { filters: 1 } }).toArray();
  return rows.map((r) => scannerFiltersSchema.parse(r.filters ?? {}));
}
