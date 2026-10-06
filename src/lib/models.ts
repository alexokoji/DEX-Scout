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
  TrustReport,
  TrustTier,
} from "@/core/types";
import type { Projection } from "@/core/analysis/projection";
import type { WalletChange } from "@/core/trading/walletResult";
import type { AiAnalysis } from "@/core/ai/schema";

export type Json = Record<string, unknown> | unknown[] | string | number | boolean | null;

export type Environment = "MANUAL" | "LIVE";
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
  maxPositionUsd: number;
  minPositionUsd: number;
  maxOpenPositions: number;
  /** optional cap on total capital deployed; null = limited only by the wallet balance */
  maxDeployedUsd: number | null;
  minOpportunityScore: number;
  minLiquidityUsd: number;
  minVolume24hUsd: number;
  maxPriceImpactPct: number;
  maxSlippageBps: number;
  maxAllowedRisk: RiskLevel;
  /** the least-earned trust the bot will buy (manual buys are warned, never blocked, below it); see core/analysis/trust.ts */
  minTrust?: TrustTier;
  targetsMode: TargetsMode;
  /** where a NEW position's targets come from when none were typed for it: the user's ladder (FIXED), or the token's own history (PROJECTED) */
  targetsSource?: "FIXED" | "PROJECTED";
  maxPositionAgeHours: number | null;
  emergencyEnabled: boolean;
  emergencyAutoExit: boolean;
  emergencyLiquidityDropPct: number;
  filters: ScannerFilters;
  weights: ScoreWeights;
  targets: ProfitTargetConfig[];
  activeStrategyId: string | null;
  /** Bumped when default gate values change; see migrateSettings in services/settings.ts. */
  settingsVersion?: number;
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
  /** the token's projected rises as of this analysis (null: not enough history) */
  projection?: Projection | null;
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
  /** Set on every analysis attempt (success, failure, or timeout) so a token that keeps failing can be
   * cooled down instead of re-winning every cron tick's small batch at the expense of fresh candidates. */
  lastAnalysisAttemptAt: Date | null;

  safety: TokenSafetyEmbed | null;
  analysis: TokenAnalysisEmbed | null;
  /** How far the token has earned trust (see core/analysis/trust.ts). Absent until the token is first analysed. */
  trustTier?: TrustTier | null;
  trust?: (TrustReport & { checkedAt: Date }) | null;
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
  target1: number | null;
  target2: number | null;
  target3: number | null;
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
  /** the market price when the buy confirmed, to compare with what was actually paid (price impact and spread) */
  entryMarketPriceUsd?: number;
  /** the wallet address that bought this position and so holds its tokens (sells are built for it) */
  walletAddress?: string | null;
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
  /** when currentPriceUsd was last actually fetched (a failed fetch must not look like a fresh price) */
  priceAt?: Date | null;
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
  /** what this trade did to the wallet's own balance, read from the confirmed transaction (fee and any token-account deposit included); absent on older trades and on sales a venue filled */
  walletChange?: WalletChange | null;
  quote: Json;
  failureReason: string | null;
  expiresAt: Date | null;
  createdAt: Date;
  executedAt: Date | null;
  transaction: TransactionEmbed | null;
}

/** An in-app notification (the bell). Also pushed to the user's ntfy/Discord channels if they set any. */
export type NotificationType = "BUY_QUEUED" | "SELL_QUEUED" | "AUTOSELL_SUGGESTED" | "AUTOSELL_PROBLEM" | "PROFIT_TAKEN" | "TRADE_EXPIRED" | "TRADE_CONFIRMED" | "TRADE_FAILED" | "POSITION_ALERT" | "SYSTEM_ALERT";

export interface NotificationDoc {
  _id: string;
  userId: string;
  type: NotificationType;
  title: string;
  body: string;
  /** in-app path to open */
  url: string;
  tradeId: string | null;
  /** at most one notification per key per reminder window (a sell that keeps re-queuing must not ping every 10 minutes) */
  dedupeKey: string | null;
  createdAt: Date;
  readAt: Date | null;
}

/** Where to send notifications beyond the in-app bell. Keyed by userId. Both optional. */
export type AutoSellStatus = "SUGGESTED" | "ACTIVE" | "FILLED" | "CANCELLED" | "EXPIRED" | "FAILED" | "SUPERSEDED";

/**
 * One auto-sell limit order for a position: a target (or merged targets) the user signs once and a keeper network fills
 * on-chain when the price is reached. See core/trading/autoSell.ts.
 */
export interface AutoSellOrderDoc {
  _id: string;
  userId: string;
  positionId: string;
  tokenId: string;
  chain: string;
  venue: "cow" | "kyber" | "jupiter";
  /** the wallet address the orders were made by (and that will receive the proceeds) */
  maker?: string | null;
  /** Kyber: what was signed (its salt, the wrapped-native taker asset, the contract, the expiry) so the order can be posted and found again */
  venueData?: { salt: string; takerAsset: string; contract: string; expiredAt: number };
  /** target levels this order covers */
  levels: number[];
  gainPct: number;
  targetPriceUsd: number;
  /** tokens to sell (human units) and the same as an integer in the token's own decimals */
  sellAmount: number;
  sellAmountRaw: string;
  /** least the order accepts, raw units of the chain's native currency (CoW: wei, Jupiter: lamports of SOL) */
  minBuyRaw: string;
  status: AutoSellStatus;
  /** CoW order uid, or the Jupiter order account */
  orderRef: string | null;
  /** CoW: when the order lapses */
  validTo: Date | null;
  /** totals already booked into the position (raw), so each sync only adds the new part */
  bookedSellRaw: string;
  bookedBuyRaw: string;
  txHashes: string[];
  error: string | null;
  createdAt: Date;
  activatedAt: Date | null;
  updatedAt: Date;
  lastSyncAt: Date | null;
  /** when the position monitor first saw the market at or above this order's target while the order was still unfilled (cleared if the price drops back) */
  targetSeenAt?: Date | null;
}

export interface NotificationPrefsDoc {
  _id: string; // userId
  /** ntfy.sh topic (free, no account): install the ntfy app and subscribe to this topic */
  ntfyTopic: string | null;
  /** Discord channel webhook URL */
  discordWebhook: string | null;
  /** categories the user switched off (see NOTIFICATION_CATEGORIES); absent = everything on */
  muted?: string[];
  updatedAt: Date;
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
