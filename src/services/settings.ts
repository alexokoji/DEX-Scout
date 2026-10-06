import { z } from "zod";
import { ORIGINAL_CHAIN_IDS } from "@/core/chains";
import {
  DEFAULT_TARGETS_MULTI,
  DEFAULT_TARGETS_SINGLE,
  scannerFiltersSchema,
  scoreWeightsSchema,
} from "@/core/config";
import { TRUST_BAR } from "@/core/analysis/trust";
import type { ProfitTargetConfig, ScannerFilters, ScoreWeights, TrustTier } from "@/core/types";
import { validateTargets } from "@/core/trading/targets";
import { collections, newId, withId } from "@/lib/db";
import { logEvent } from "@/lib/events";
import type { Environment, RiskLevel, TargetsMode, TradingSettingsDoc } from "@/lib/models";

export const tradingSettingsInput = z
  .object({
    environment: z.enum(["MANUAL", "LIVE"]),
    autoTradingEnabled: z.boolean(),
    maxPositionUsd: z.number().positive(),
    minPositionUsd: z.number().min(0),
    maxOpenPositions: z.number().int().min(1).max(500),
    maxDeployedUsd: z.number().positive().nullable(),
    minOpportunityScore: z.number().min(0).max(100),
    minLiquidityUsd: z.number().min(0),
    minVolume24hUsd: z.number().min(0),
    maxPriceImpactPct: z.number().min(0.01).max(50),
    maxSlippageBps: z.number().int().min(1).max(5000),
    maxAllowedRisk: z.enum(["LOWER", "MODERATE", "HIGH"]),
    minTrust: z.enum(["UNPROVEN", "TRUSTED", "VERIFIED"]),
    targetsMode: z.enum(["SINGLE", "MULTI"]),
    targetsSource: z.enum(["FIXED", "PROJECTED"]),
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
    if (v.maxDeployedUsd !== null && v.maxPositionUsd > v.maxDeployedUsd) ctx.addIssue({ code: "custom", path: ["maxPositionUsd"], message: "Maximum position exceeds the maximum deployed" });
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
  maxPositionUsd: number;
  minPositionUsd: number;
  maxOpenPositions: number;
  maxDeployedUsd: number | null;
  minOpportunityScore: number;
  minLiquidityUsd: number;
  minVolume24hUsd: number;
  maxPriceImpactPct: number;
  maxSlippageBps: number;
  maxAllowedRisk: RiskLevel;
  /** the least-earned trust the bot will buy */
  minTrust: TrustTier;
  targetsMode: TargetsMode;
  /** where a new position's targets come from when none were set for it: this ladder, or the token's own history */
  targetsSource: "FIXED" | "PROJECTED";
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
  // accounts created before v4 may still carry the retired capitalUsd; never surface it
  const { id, capitalUsd: _legacyCapital, ...rest } = withId(row) as ReturnType<typeof withId<TradingSettingsDoc>> & { capitalUsd?: number };
  return {
    id,
    ...rest,
    minTrust: row.minTrust ?? DEFAULT_MIN_TRUST,
    targetsSource: row.targetsSource ?? "FIXED",
    filters: scannerFiltersSchema.parse(row.filters ?? {}),
    weights: scoreWeightsSchema.parse(row.weights ?? {}),
    targets: targets.length ? targets : row.targetsMode === "SINGLE" ? DEFAULT_TARGETS_SINGLE : DEFAULT_TARGETS_MULTI,
  };
}

/** The bot buys nothing below this: no red flags AND depth, history and checks that cleared (see core/analysis/trust.ts). */
export const DEFAULT_MIN_TRUST: TrustTier = "TRUSTED";

export const SETTINGS_VERSION = 6;

/** True when `chains` holds exactly the six chains this app originally scanned (any order). */
export function isOriginalChainSet(chains: readonly string[] | undefined): boolean {
  if (!chains) return false;
  const set = new Set(chains);
  return set.size === ORIGINAL_CHAIN_IDS.length && ORIGINAL_CHAIN_IDS.every((c) => set.has(c));
}

/** The one place new accounts' settings come from (registration and lazy creation both use it). */
export function defaultSettingsDoc(userId: string, now = new Date()): TradingSettingsDoc {
  return {
    _id: newId(),
    userId,
    environment: "MANUAL",
    autoTradingEnabled: false,
    maxPositionUsd: 10,
    minPositionUsd: 5,
    maxOpenPositions: 10,
    maxDeployedUsd: null,
    minOpportunityScore: 55,
    minLiquidityUsd: TRUST_BAR.minLiquidityUsd,
    minVolume24hUsd: TRUST_BAR.minVolume24hUsd,
    maxPriceImpactPct: 3,
    maxSlippageBps: 300,
    maxAllowedRisk: "MODERATE",
    minTrust: DEFAULT_MIN_TRUST,
    targetsMode: "MULTI",
    targetsSource: "FIXED",
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

/** The v4 defaults for the liquidity and volume gates, replaced in v5. */
const V4_LIQUIDITY = 20_000;
const V4_VOLUME = 10_000;

/** The v1 defaults that turned out to block nearly every token. Only values still equal to these get moved. */
const V1_TOP = { minOpportunityScore: 70, minLiquidityUsd: 100_000, minVolume24hUsd: 50_000, maxPriceImpactPct: 2 } as const;
const V1_FILTERS = { minMarketCapUsd: 1_000_000, maxMarketCapUsd: 10_000_000, minLiquidityUsd: 100_000, minVolume24hUsd: 50_000, minHolders: 300, maxTokenAgeHours: 24 * 30, minTxCount1h: 50 } as const;

/**
 * Accounts created before v2 hold the old, overly strict gates as explicit stored values, so changing the code
 * defaults alone would never reach them. Move any gate still sitting exactly at its v1 default to the v2 default;
 * anything the user changed on purpose is left alone. Runs once per account (settingsVersion is persisted).
 */
async function migrateSettings(row: TradingSettingsDoc): Promise<TradingSettingsDoc> {
  const version = row.settingsVersion ?? 1;
  if (version >= SETTINGS_VERSION) return row;
  const fresh = defaultSettingsDoc(row.userId);
  const set: Record<string, unknown> = { settingsVersion: SETTINGS_VERSION };
  if (version < 2) {
    for (const k of Object.keys(V1_TOP) as (keyof typeof V1_TOP)[]) if (row[k] === V1_TOP[k]) set[k] = fresh[k];
    for (const k of Object.keys(V1_FILTERS) as (keyof typeof V1_FILTERS)[]) {
      if (row.filters?.[k] === V1_FILTERS[k]) set[`filters.${k}`] = fresh.filters[k];
    }
  }
  // v3: more chains exist now. An account whose chain list is exactly the original six never chose that subset —
  // it is just the old default — so it gets every chain; anyone who picked a different set keeps their choice.
  if (version < 3 && isOriginalChainSet(row.filters?.chains)) set["filters.chains"] = fresh.filters.chains;
  // v4: capital now comes from the connected wallet (the typed-in "trading capital" was a demo-trading leftover, and its
  // $100 default also capped deployment). Drop it, and lift the old $100 default cap; a cap the user chose is kept.
  // v5: tokens must earn trust, and "real liquidity" now means $50K. A gate still sitting at its v4 default ($20K liquidity,
  // $10K volume) moves up with it; one the user set on purpose is left alone. Everyone gets the trust floor.
  if (version < 5) {
    if (row.minLiquidityUsd === V4_LIQUIDITY) set.minLiquidityUsd = fresh.minLiquidityUsd;
    if (row.minVolume24hUsd === V4_VOLUME) set.minVolume24hUsd = fresh.minVolume24hUsd;
    if (row.filters?.minLiquidityUsd === V4_LIQUIDITY) set["filters.minLiquidityUsd"] = fresh.filters.minLiquidityUsd;
    if (row.filters?.minVolume24hUsd === V4_VOLUME) set["filters.minVolume24hUsd"] = fresh.filters.minVolume24hUsd;
    if (!row.minTrust) set.minTrust = DEFAULT_MIN_TRUST;
  }
  // v6: each position can have its own targets. Existing accounts keep their one ladder as the default for new positions.
  if (version < 6 && !row.targetsSource) set.targetsSource = "FIXED";
  const legacy = row as TradingSettingsDoc & { capitalUsd?: number };
  const unset: Record<string, ""> = {};
  if (version < 4) {
    if (legacy.capitalUsd !== undefined) unset.capitalUsd = "";
    if (row.maxDeployedUsd === 100) set.maxDeployedUsd = null;
  }
  const col = await collections.tradingSettings();
  await col.updateOne({ _id: row._id }, { $set: set, ...(Object.keys(unset).length ? { $unset: unset } : {}) });
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
