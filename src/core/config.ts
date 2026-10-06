import { z } from "zod";
import { TRUST_BAR } from "./analysis/trust";
import { CHAIN_IDS } from "./chains";
import type { ProfitTargetConfig, ScannerFilters, ScoreWeights, TrustTier } from "./types";

export const scannerFiltersSchema = z.object({
  // Defaults were $1M-$10M cap / $100k liquidity / $50k volume / 300 holders / 50 tx per hour / 30-day age
  // cap, which in practice passed ~2 of ~160 discovered tokens (and the age cap silently excluded every
  // established token). These still screen out dust and dead pools, but leave a workable universe; a
  // trade's own price-impact check (not an absolute pool-size floor) is what protects a given position size.
  minMarketCapUsd: z.number().min(0).default(250_000),
  maxMarketCapUsd: z.number().min(0).default(25_000_000),
  // $50K / $20K: the depth below which a token can't earn trust (see TRUST_BAR). Tokens thinner than this are mostly
  // brand-new launches whose liquidity one wallet can pull; they were the bulk of what the scanner used to list.
  minLiquidityUsd: z.number().min(0).default(TRUST_BAR.minLiquidityUsd),
  minVolume24hUsd: z.number().min(0).default(TRUST_BAR.minVolume24hUsd),
  minHolders: z.number().int().min(0).default(50),
  maxTokenAgeHours: z.number().min(0).nullable().default(null),
  minTxCount1h: z.number().int().min(0).default(15),
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

/**
 * Minimum opportunity score for a BUY (vs WATCH) signal. The score is calibrated so an ordinary, balanced
 * market scores ~50 (measured on live data: real tokens land at roughly 47-60, best ~59), so the old 70/60
 * cut-offs sat above every real token and produced zero signals. WATCH = "worth a look", BUY = the top tier
 * of what the market is actually offering. Both still require a passing safety screen, and a BUY additionally
 * needs an acceptable risk level and a trend that isn't down or overextended. Every trade — manual or the
 * bot's — still needs the user's own wallet signature, so a lower bar widens the list, not anyone's authority.
 */
/**
 * A listed price older than this is not shown as current anywhere (lists, signals) and a token with one cannot be
 * signalled. Prices move a lot in minutes on these tokens; the scanner refreshes tracked ones every few minutes.
 */
export const PRICE_MAX_AGE_MS = 30 * 60_000;
/** Past this a price is shown as aging (amber) so the user knows it is not live. */
export const PRICE_WARN_AGE_MS = 5 * 60_000;

export const SIGNAL_THRESHOLDS = { buy: 56, watch: 50 } as const;

/** The least-earned trust a token needs before a BUY or WATCH signal is raised for it (see core/analysis/trust.ts). */
export const SIGNAL_MIN_TRUST: TrustTier = "TRUSTED";

/** How long a generated signal stays actionable. */
export const SIGNAL_TTL_MINUTES = 90;

export const DEFAULT_TARGETS_MULTI: ProfitTargetConfig[] = [
  { level: 1, gainPct: 8, sellPct: 25 },
  { level: 2, gainPct: 15, sellPct: 25 },
  { level: 3, gainPct: 25, sellPct: 25 },
  { level: 4, gainPct: 40, sellPct: 100 }, // remainder
];
export const DEFAULT_TARGETS_SINGLE: ProfitTargetConfig[] = [{ level: 1, gainPct: 10, sellPct: 100 }];

/**
 * Fee model for the MOCK market only. Live trading never uses these: Solana fees are read from the chain
 * (providers/solana/fees.ts) and EVM fees from the current gas price (providers/evm/evmProviders.ts).
 */
export const FEES = {
  networkFeeSol: 0.000005,
  defaultPriorityFeeSol: 0.0001,
  solUsd: 150, // only used for mock / paper fee conversion
  /** aggregator + LP fee approximation for paper fills, in bps */
  swapFeeBps: 30,
} as const;
