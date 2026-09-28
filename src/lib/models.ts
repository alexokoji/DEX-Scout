/**
 * MongoDB document shapes for every collection. There is no ORM here — these are plain TypeScript
 * interfaces describing what `src/lib/db.ts`'s typed collection getters read and write with the native
 * `mongodb` driver. `_id` is always a UUID string (see `newId()`), never a `mongodb` `ObjectId`; callers
 * work with plain `id: string` values everywhere (the `withId`/`withIds` helpers rename `_id` -> `id` at
 * the point documents leave the data layer).
 *
 * A handful of 1:1, always-loaded-together relations from the old schema are embedded as subdocuments
 * instead of separate collections (Trade.transaction, Signal.analysis, Token.safety, Token.analysis,
 * TradingSettings.targets) — this is the natural Mongo-native shape, not a translation shortcut.
 */
import type {
  MarketAnalysis,
  OnChainAnalysis,
  OnChainRaw,
  ProfitTargetConfig,
  RiskLevel,
  ScannerFilters,
  ScoreComponent,
  ScoreWeights,
  TokenSnapshot,
} from "@/core/types";
import type { AiAnalysis } from "@/core/ai/schema";

export type Json = Record<string, unknown> | unknown[] | string | number | boolean | null;

export type Environment = "MANUAL" | "PAPER" | "LIVE";
export type DataSourceKind = "MOCK" | "LIVE";
export type TokenStage = "DISCOVERED" | "SCANNED" | "SAFETY_CHECK" | "ANALYZED" | "QUALIFIED" | "SIGNAL_GENERATED" | "FILTERED";
export type SignalStatus = "ACTIVE" | "EXPIRED" | "CONSUMED";
export type BotStatus = "ACTIVE" | "PAUSED" | "DISABLED";
export type PositionStatus = "OPEN" | "TARGET_1" | "TARGET_2" | "TARGET_3" | "PROFITABLE" | "EMERGENCY" | "CLOSED";
export type PositionHealth = "HOLD" | "MONITOR" | "WARNING" | "EMERGENCY";
export type TradeSide = "BUY" | "SELL";
export type TradeKind = "MANUAL_ENTRY" | "AUTO_ENTRY" | "TARGET_EXIT" | "MANUAL_EXIT" | "EMERGENCY_EXIT";
export type TradeStatus = "PREPARED" | "PENDING" | "CONFIRMED" | "FAILED" | "CANCELLED" | "EXPIRED";
export type TargetsMode = "SINGLE" | "MULTI";
export type EventLevel = "DEBUG" | "INFO" | "WARN" | "ERROR";
export type { RiskLevel };

export interface UserDoc {
  _id: string;
  email: string;
  name: string | null;
  passwordHash: string;
  role: string;
  createdAt: Date;
}

export interface WalletDoc {
  _id: string;
  userId: string;
  /** address family: "solana" or "evm" (one EVM address covers every EVM chain) */
  chain: string;
  address: string;
  label: string | null;
  verifiedAt: Date;
  createdAt: Date;
}

export interface TradingAccountDoc {
  _id: string;
  userId: string;
  environment: Environment;
  realizedPnlUsd: number;
  createdAt: Date;
}

export interface TradingSettingsDoc {
  _id: string;
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
  activeStrategyId: string | null;
  updatedAt: Date;
}

export interface StrategyDoc {
  _id: string;
  userId: string;
  name: string;
  description: string | null;
  config: Json;
  isDefault: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export interface TokenSafetyEmbed {
  riskScore: number;
  riskLevel: RiskLevel;
  passed: boolean;
  warnings: string[];
  criticalIssues: string[];
  details: OnChainRaw;
  checkedAt: Date;
}

export interface TokenAnalysisEmbed {
  opportunityScore: number;
  components: ScoreComponent[];
  market: MarketAnalysis;
  onchain: OnChainAnalysis;
  /** full TokenSnapshot + OnChainRaw used to rebuild the Analysis object for the signal engine */
  snapshot: TokenSnapshot;
  raw: OnChainRaw;
  computedAt: Date;
  updatedAt: Date;
}

export interface TokenDoc {
  _id: string;
  chain: string;
  address: string;
  name: string;
  symbol: string;
  decimals: number;
  dex: string;
  poolAddress: string | null;
  logoUrl: string | null;
  dataSource: DataSourceKind;
  stage: TokenStage;
  poolCreatedAt: Date | null;
  firstSeenAt: Date;
  lastScannedAt: Date;
  updatedAt: Date;

  priceUsd: number;
  marketCapUsd: number;
  fdvUsd: number;
  liquidityUsd: number;
  volume24hUsd: number;
  volume1hUsd: number;
  change5m: number;
  change1h: number;
  change24h: number;
  buySellRatio: number;
  holders: number;
  holderGrowth1h: number;
  txCount1h: number;
  pairCount: number;
  opportunityScore: number;
  riskLevel: RiskLevel;
  passedFilters: boolean;

  safety: TokenSafetyEmbed | null;
  analysis: TokenAnalysisEmbed | null;
}

export interface TokenMetricDoc {
  _id: string;
  tokenId: string;
  ts: Date;
  priceUsd: number;
  marketCapUsd: number;
  fdvUsd: number;
  liquidityUsd: number;
  volume5m: number;
  volume15m: number;
  volume30m: number;
  volume1h: number;
  volume24h: number;
  buys5m: number;
  sells5m: number;
  buys1h: number;
  sells1h: number;
  holders: number;
  pairCount: number;
}

export interface PriceSnapshotDoc {
  _id: string;
  tokenId: string;
  ts: Date;
  priceUsd: number;
  liquidityUsd: number;
}

export interface VolumeSnapshotDoc {
  _id: string;
  tokenId: string;
  ts: Date;
  volume5m: number;
  volume1h: number;
  volume24h: number;
  buys5m: number;
  sells5m: number;
}

export interface LiquidityPoolDoc {
  _id: string;
  tokenId: string;
  chain: string;
  address: string;
  dex: string;
  quoteSymbol: string;
  liquidityUsd: number;
  createdAtChain: Date | null;
  updatedAt: Date;
}

export interface SignalAnalysisEmbed {
  snapshot: Json;
  ai: AiAnalysis | null;
  aiProvider: string | null;
  createdAt: Date;
}

export interface SignalDoc {
  _id: string;
  tokenId: string;
  type: "BUY" | "WATCH" | "HOLD" | "EXIT";
  status: SignalStatus;
  dataSource: DataSourceKind;
  score: number;
  opportunityScore: number;
  riskLevel: RiskLevel;
  priceUsd: number;
  entryMin: number;
  entryMax: number;
  target1: number;
  target2: number;
  target3: number;
  reasons: string[];
  warnings: string[];
  createdAt: Date;
  updatedAt: Date;
  expiresAt: Date;
  analysis: SignalAnalysisEmbed | null;
}

export interface BotDoc {
  _id: string;
  userId: string;
  status: BotStatus;
  environment: Environment;
  lastRunAt: Date | null;
  emergencyStoppedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface BotRunDoc {
  _id: string;
  botId: string;
  startedAt: Date;
  finishedAt: Date | null;
  signalsEvaluated: number;
  tradesExecuted: number;
  tradesSkipped: number;
  error: string | null;
  summary: Json | null;
}

export interface PositionDoc {
  _id: string;
  userId: string;
  accountId: string;
  tokenId: string;
  environment: Environment;
  status: PositionStatus;
  health: PositionHealth;
  healthNotes: Json | null;
  origin: string; // "MANUAL" | "AUTO"
  sourceSignalId: string | null;
  entryPriceUsd: number;
  currentPriceUsd: number;
  initialAmount: number;
  amount: number;
  investedUsd: number;
  costBasisUsd: number;
  realizedPnlUsd: number;
  targetsHit: number;
  targetsSnapshot: ProfitTargetConfig[];
  emergencyEnabled: boolean;
  emergencyAutoExit: boolean;
  openedAt: Date;
  updatedAt: Date;
  closedAt: Date | null;
  lastAnalysisAt: Date | null;
}

export interface PositionEventDoc {
  _id: string;
  positionId: string;
  type: string;
  message: string;
  data: Json | null;
  createdAt: Date;
}

export interface TransactionEmbed {
  chain: string;
  signature: string | null;
  status: string; // PENDING | CONFIRMED | FAILED
  unsignedTx: string | null;
  error: string | null;
  slot: number | null;
  submittedAt: Date | null;
  confirmedAt: Date | null;
  createdAt: Date;
}

export interface TradeDoc {
  _id: string;
  userId: string;
  accountId: string;
  tokenId: string;
  positionId: string | null;
  side: TradeSide;
  kind: TradeKind;
  environment: Environment;
  dataSource: DataSourceKind;
  status: TradeStatus;
  inputUsd: number;
  tokenAmount: number;
  priceUsd: number;
  priceImpactPct: number;
  slippageBps: number;
  feesUsd: number;
  networkFeeUsd: number;
  realizedPnlUsd: number | null;
  quote: Json;
  failureReason: string | null;
  expiresAt: Date | null;
  createdAt: Date;
  executedAt: Date | null;
  transaction: TransactionEmbed | null;
}

export interface SystemEventDoc {
  _id: string;
  ts: Date;
  type: string;
  level: EventLevel;
  source: string;
  message: string;
  userId: string | null;
  data: Json | null;
}

/** Heartbeat + short-lived lease for background jobs (local workers or serverless cron). */
export interface WorkerStateDoc {
  _id: string; // worker/job name, e.g. "scanner-worker" or "cron:scan"
  lastRunAt: Date | null;
  lastError: string | null;
  leaseUntil: Date | null;
  runs: number;
  stats: Json | null;
  updatedAt: Date;
}
