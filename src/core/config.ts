import { z } from "zod";
import { CHAIN_IDS } from "./chains";
import type { ProfitTargetConfig, ScannerFilters, ScoreWeights } from "./types";

export const scannerFiltersSchema = z.object({
  minMarketCapUsd: z.number().min(0).default(1_000_000),
  maxMarketCapUsd: z.number().min(0).default(10_000_000),
  minLiquidityUsd: z.number().min(0).default(100_000),
  minVolume24hUsd: z.number().min(0).default(50_000),
  minHolders: z.number().int().min(0).default(300),
  maxTokenAgeHours: z.number().min(0).nullable().default(24 * 30),
  minTxCount1h: z.number().int().min(0).default(50),
  maxPriceImpactPct: z.number().min(0).max(100).default(3),
  priceImpactProbeUsd: z.number().min(1).default(100),
  dexes: z.array(z.string()).default([]),
  chains: z.array(z.enum(CHAIN_IDS)).default([...CHAIN_IDS]),
});

export const scoreWeightsSchema = z.object({
  liquidity: z.number().min(0).default(15),
  volume: z.number().min(0).default(15),
  momentum: z.number().min(0).default(15),
  buySellPressure: z.number().min(0).default(15),
  priceStructure: z.number().min(0).default(10),
  holderGrowth: z.number().min(0).default(10),
  txActivity: z.number().min(0).default(10),
  tokenAge: z.number().min(0).default(5),
  liquidityStability: z.number().min(0).default(5),
});

export const DEFAULT_FILTERS: ScannerFilters = scannerFiltersSchema.parse({});
export const DEFAULT_WEIGHTS: ScoreWeights = scoreWeightsSchema.parse({});

/** Minimum opportunity score for a BUY (vs WATCH) signal. */
export const SIGNAL_THRESHOLDS = { buy: 70, watch: 60 } as const;

/** How long a generated signal stays actionable. */
export const SIGNAL_TTL_MINUTES = 90;

export const DEFAULT_TARGETS_MULTI: ProfitTargetConfig[] = [
  { level: 1, gainPct: 8, sellPct: 25 },
  { level: 2, gainPct: 15, sellPct: 25 },
  { level: 3, gainPct: 25, sellPct: 25 },
  { level: 4, gainPct: 40, sellPct: 100 }, // remainder
];
export const DEFAULT_TARGETS_SINGLE: ProfitTargetConfig[] = [{ level: 1, gainPct: 10, sellPct: 100 }];

/** Rough Solana fee model used by paper trading and quote estimates. */
export const FEES = {
  networkFeeSol: 0.000005,
  defaultPriorityFeeSol: 0.0001,
  solUsd: 150, // only used for mock / paper fee conversion
  /** aggregator + LP fee approximation for paper fills, in bps */
  swapFeeBps: 30,
} as const;
