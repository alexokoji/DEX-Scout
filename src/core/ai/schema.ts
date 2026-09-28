import { z } from "zod";

/** Structured, size-bounded facts handed to the AI layer. The AI never sees credentials or user funds. */
export const aiInputSchema = z.object({
  symbol: z.string(),
  name: z.string(),
  priceUsd: z.number(),
  marketCapUsd: z.number(),
  liquidityUsd: z.number(),
  volume24hUsd: z.number(),
  change5m: z.number(),
  change1h: z.number(),
  buySellRatio: z.number(),
  holders: z.number(),
  holderGrowthPct1h: z.number(),
  liquidityTrendPct: z.number(),
  volumeSpike: z.number().nullable(),
  trend: z.enum(["UP", "DOWN", "SIDEWAYS"]),
  rsi14: z.number().nullable(),
  breakout: z.boolean(),
  pullback: z.boolean(),
  whaleBias: z.enum(["ACCUMULATION", "DISTRIBUTION", "NEUTRAL"]),
  topHolderPct: z.number(),
  riskLevel: z.enum(["LOWER", "MODERATE", "HIGH", "CRITICAL"]),
  criticalIssues: z.array(z.string()),
  warnings: z.array(z.string()),
  opportunityScore: z.number(),
  signalType: z.enum(["BUY", "WATCH", "HOLD", "EXIT"]),
  strategySummary: z.string(),
});
export type AiInput = z.infer<typeof aiInputSchema>;

/** Every AI answer must parse into this shape; free text can never reach the trading engine. */
export const aiAnalysisSchema = z.object({
  whatIsHappening: z.string().min(1).max(1200),
  whyInteresting: z.string().min(1).max(1200),
  recentChanges: z.string().min(1).max(1200),
  strategyFit: z.object({
    matches: z.boolean(),
    explanation: z.string().min(1).max(800),
  }),
  primaryRisks: z.array(z.string().max(300)).max(8),
  invalidation: z.array(z.string().max(300)).max(6),
});
export type AiAnalysis = z.infer<typeof aiAnalysisSchema>;
