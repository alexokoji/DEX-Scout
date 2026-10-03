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

export const SETTINGS_VERSION = 2;

/** The one place new accounts' settings come from (registration and lazy creation both use it). */
export function defaultSettingsDoc(userId: string, now = new Date()): TradingSettingsDoc {
  return {
    _id: newId(),
    userId,
    environment: "MANUAL",
    autoTradingEnabled: false,
    capitalUsd: 100,
    maxPositionUsd: 10,
    minPositionUsd: 5,
    maxOpenPositions: 10,
    maxDeployedUsd: 100,
    minOpportunityScore: 55,
    minLiquidityUsd: 20_000,
    minVolume24hUsd: 10_000,
    maxPriceImpactPct: 3,
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
    settingsVersion: SETTINGS_VERSION,
    updatedAt: now,
  };
}

/** The v1 defaults that turned out to block nearly every token. Only values still equal to these get moved. */
const V1_TOP = { minOpportunityScore: 70, minLiquidityUsd: 100_000, minVolume24hUsd: 50_000, maxPriceImpactPct: 2 } as const;
const V1_FILTERS = { minMarketCapUsd: 1_000_000, maxMarketCapUsd: 10_000_000, minLiquidityUsd: 100_000, minVolume24hUsd: 50_000, minHolders: 300, maxTokenAgeHours: 24 * 30, minTxCount1h: 50 } as const;

/**
 * Accounts created before v2 hold the old, overly strict gates as explicit stored values, so changing the code
 * defaults alone would never reach them. Move any gate still sitting exactly at its v1 default to the v2 default;
 * anything the user changed on purpose is left alone. Runs once per account (settingsVersion is persisted).
 */
async function migrateSettings(row: TradingSettingsDoc): Promise<TradingSettingsDoc> {
  if ((row.settingsVersion ?? 1) >= SETTINGS_VERSION) return row;
  const fresh = defaultSettingsDoc(row.userId);
  const set: Record<string, unknown> = { settingsVersion: SETTINGS_VERSION };
  for (const k of Object.keys(V1_TOP) as (keyof typeof V1_TOP)[]) if (row[k] === V1_TOP[k]) set[k] = fresh[k];
  for (const k of Object.keys(V1_FILTERS) as (keyof typeof V1_FILTERS)[]) {
    if (row.filters?.[k] === V1_FILTERS[k]) set[`filters.${k}`] = fresh.filters[k];
  }
  const col = await collections.tradingSettings();
  await col.updateOne({ _id: row._id }, { $set: set });
  return (await col.findOne({ _id: row._id })) ?? row;
}

export async function getSettings(userId: string): Promise<UserSettings> {
  const col = await collections.tradingSettings();
  const existing = await col.findOne({ userId });
  if (existing) return hydrate(await migrateSettings(existing));
  const doc = defaultSettingsDoc(userId);
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
  const rows = await col.find({}).toArray();
  // The scanner reads filters here rather than through getSettings, so migrate stale rows here too —
  // otherwise it would keep scanning with the old strict bands until that user next opened the app.
  const migrated = await Promise.all(rows.map((r) => migrateSettings(r)));
  return migrated.map((r) => scannerFiltersSchema.parse(r.filters ?? {}));
}
