/** Chain-agnostic domain types shared by every engine. No framework or DB imports here. */

export type ChainId =
  | "solana" | "ethereum" | "base" | "bsc" | "arbitrum" | "polygon"
  | "robinhood" | "avalanche" | "optimism" | "unichain" | "linea" | "sonic" | "berachain" | "hyperevm"
  | "ink" | "mantle" | "scroll" | "blast" | "world" | "abstract" | "monad";
export type RiskLevel = "LOWER" | "MODERATE" | "HIGH" | "CRITICAL";
export type SignalType = "BUY" | "WATCH" | "HOLD" | "EXIT";
export type Environment = "MANUAL" | "LIVE";
export type DataSourceKind = "MOCK" | "LIVE";
export type Timeframe = "1m" | "5m" | "15m" | "30m" | "1h" | "4h";
export type TrendDirection = "UP" | "DOWN" | "SIDEWAYS";

export const TIMEFRAMES: Timeframe[] = ["1m", "5m", "15m", "30m", "1h", "4h"];
export const TIMEFRAME_MINUTES: Record<Timeframe, number> = {
  "1m": 1,
  "5m": 5,
  "15m": 15,
  "30m": 30,
  "1h": 60,
  "4h": 240,
};

export interface Candle {
  /** unix seconds, candle open time */
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  /** USD volume */
  volume: number;
  buys: number;
  sells: number;
}

/** A point-in-time observation of one token, as returned by a TokenDataProvider. */
export interface TokenSnapshot {
  chain: ChainId;
  address: string;
  name: string;
  symbol: string;
  decimals: number;
  dex: string;
  poolAddress: string;
  poolCreatedAt: Date;
  pairCount: number;
  priceUsd: number;
  marketCapUsd: number;
  fdvUsd: number;
  liquidityUsd: number;
  /** liquidity one hour ago; used for liquidity trend */
  liquidity1hAgoUsd: number;
  volume5m: number;
  volume15m: number;
  volume30m: number;
  volume1h: number;
  volume24h: number;
  buys5m: number;
  sells5m: number;
  buys15m: number;
  sells15m: number;
  buys1h: number;
  sells1h: number;
  change5m: number;
  change1h: number;
  change24h: number;
  holders: number;
  holders1hAgo: number;
  observedAt: Date;
  dataSource: DataSourceKind;
}

export interface OnChainRaw {
  mintAuthorityRevoked: boolean;
  freezeAuthorityRevoked: boolean;
  verified: boolean;
  topHolderPct: number;
  top10HolderPct: number;
  /** false when a sell simulation fails / honeypot-like behaviour is detected */
  sellSimulationOk: boolean;
  metadataAnomalies: string[];
  largeBuys1h: number;
  largeSells1h: number;
  largeBuyUsd1h: number;
  largeSellUsd1h: number;
  newHolders1h: number;
  liquidityAddedUsd1h: number;
  liquidityRemovedUsd1h: number;
  suspiciousTxRatio: number; // 0..1 share of txs flagged as wash/bot-like
  poolActive: boolean;
  /**
   * false when the authority/holder RPC lookups themselves failed (timeout, rate limit). In that case
   * mintAuthorityRevoked/freezeAuthorityRevoked/topHolder* are placeholders, NOT findings — the safety
   * engine must treat them as unknown rather than as "authority still active". Omitted/true = real data.
   */
  dataAvailable?: boolean;
  /** false when authorities were read but the top-holder lookup was not possible (needs a capable RPC). Omitted/true = real data. */
  holderDataAvailable?: boolean;
  /** What independent verification services said about this token (see providers/trust). Absent = none could be reached. */
  trust?: TrustFacts;
}

/** How far a token has earned trust, worst to best. Order matters: see TRUST_RANK. */
export type TrustTier = "DANGEROUS" | "RISKY" | "UNPROVEN" | "TRUSTED" | "VERIFIED";
export const TRUST_TIERS: TrustTier[] = ["DANGEROUS", "RISKY", "UNPROVEN", "TRUSTED", "VERIFIED"];
export const TRUST_RANK: Record<TrustTier, number> = { DANGEROUS: 0, RISKY: 1, UNPROVEN: 2, TRUSTED: 3, VERIFIED: 4 };
export const TRUST_LABEL: Record<TrustTier, string> = { DANGEROUS: "Dangerous", RISKY: "Risky", UNPROVEN: "Unproven", TRUSTED: "Trusted", VERIFIED: "Verified" };

/**
 * Facts from independent verification services, each null when that service could not say. "Unknown" is never treated as
 * "fine": a missing answer keeps a token from earning trust, it does not earn it.
 */
export interface TrustFacts {
  /** the services that actually answered ("jupiter", "rugcheck", "goplus", "honeypot.is") */
  sources: string[];
  /** on an established, curated token list (Jupiter's verified list on Solana, GoPlus's trusted list on EVM chains) */
  listed: boolean | null;
  /** Jupiter's 0-100 measure of how much of the trading is real people rather than bots */
  organicScore: number | null;
  /** a real simulated sell failed / the token is flagged a honeypot */
  honeypot: boolean | null;
  /** a real buy-then-sell simulation ran (true) or could not be run (false/null) */
  sellSimulated: boolean | null;
  buyTaxPct: number | null;
  sellTaxPct: number | null;
  /** contract source code is published and verified (EVM) */
  openSource: boolean | null;
  mintable: boolean | null;
  upgradeableProxy: boolean | null;
  hiddenOwner: boolean | null;
  canReclaimOwnership: boolean | null;
  pausable: boolean | null;
  blacklist: boolean | null;
  /** % of the liquidity that is locked or burned, 0-100 */
  lpLockedPct: number | null;
  holders: number | null;
  /** % of supply held by the creator/dev wallet */
  creatorPct: number | null;
  rugged: boolean | null;
  /**
   * Whether any checking service covers this chain at all: true when at least one answered or the chain is on a service's list,
   * false when none covers it (so no token there CAN be checked, which is not the same as a token that failed its checks),
   * null when that is not known.
   */
  covered: boolean | null;
  /** named problems the services flagged ("danger" level) and softer cautions ("warn" level) */
  dangers: string[];
  cautions: string[];
}

export type TrustCheckStatus = "pass" | "fail" | "unknown";
export interface TrustCheck {
  id: string;
  label: string;
  status: TrustCheckStatus;
  detail: string;
}
export interface TrustReport {
  tier: TrustTier;
  /** one line a person can read: why the token is at this tier */
  summary: string;
  checks: TrustCheck[];
  /** what stands between this token and the next tier up (empty at VERIFIED, or when nothing more can be earned) */
  missing: string[];
  /** how many independent services contributed */
  sources: string[];
  /** no checking service covers this token's chain, so it can't earn trust there however good it looks (see TrustFacts.covered) */
  unverifiable?: boolean;
}

export interface ScannerFilters {
  minMarketCapUsd: number;
  maxMarketCapUsd: number;
  minLiquidityUsd: number;
  minVolume24hUsd: number;
  minHolders: number;
  /** hours; null = unlimited */
  maxTokenAgeHours: number | null;
  minTxCount1h: number;
  maxPriceImpactPct: number;
  /** trade size (USD) used to evaluate price impact for filtering */
  priceImpactProbeUsd: number;
  dexes: string[]; // empty = all
  chains: ChainId[];
}

export interface ScoreWeights {
  liquidity: number;
  volume: number;
  momentum: number;
  buySellPressure: number;
  priceStructure: number;
  holderGrowth: number;
  txActivity: number;
  tokenAge: number;
  liquidityStability: number;
}

export interface SafetyResult {
  riskScore: number; // 0 (lowest risk) .. 100
  riskLevel: RiskLevel;
  passed: boolean;
  warnings: string[];
  criticalIssues: string[];
}

export interface IndicatorSet {
  ema9: number | null;
  ema21: number | null;
  sma20: number | null;
  sma50: number | null;
  rsi14: number | null;
  macd: { macd: number; signal: number; histogram: number } | null;
  vwap: number | null;
  volumeAvg20: number | null;
  volumeSpike: number | null; // last volume / avg
  atr14: number | null;
}

export interface MarketAnalysis {
  timeframe: Timeframe;
  trend: TrendDirection;
  priceMomentum: number; // -1..1
  volumeMomentum: number; // -1..1 (short vs long window)
  liquidityTrend: number; // pct change vs 1h ago
  buySellRatio: number;
  txMomentum: number; // -1..1
  holderGrowthPct: number;
  support: number | null;
  resistance: number | null;
  breakout: boolean;
  pullback: boolean;
  indicators: IndicatorSet;
  /** price-structure quality 0..1 (higher lows, above key averages, not overextended) */
  structureScore: number;
  overextended: boolean;
}

export interface OnChainAnalysis {
  holderGrowthPct1h: number;
  newHolders1h: number;
  largeBuys: number;
  largeSells: number;
  whaleNetFlowUsd: number;
  whaleBias: "ACCUMULATION" | "DISTRIBUTION" | "NEUTRAL";
  topHolderPct: number;
  top10HolderPct: number;
  txAcceleration: number; // -1..1 (last 5m tx rate vs 1h average)
  liquidityAddedUsd: number;
  liquidityRemovedUsd: number;
  netLiquidityUsd: number;
}

export interface ScoreComponent {
  key: keyof ScoreWeights;
  label: string;
  /** 0..1 */
  value: number;
  weight: number;
}

export interface OpportunityScore {
  /** 0..100 analytical metric, NOT a probability of profit */
  score: number;
  components: ScoreComponent[];
}

export interface Analysis {
  snapshot: TokenSnapshot;
  onchainRaw: OnChainRaw;
  safety: SafetyResult;
  market: MarketAnalysis;
  onchain: OnChainAnalysis;
  opportunity: OpportunityScore;
  /** how far this token has earned trust (derived from the snapshot and the raw facts) */
  trust: TrustReport;
  computedAt: Date;
}

export interface SignalDraft {
  type: SignalType;
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
  expiresAt: Date;
}

export interface ProfitTargetConfig {
  level: number;
  gainPct: number;
  /** percentage of the initial position amount sold at this level; last level sells all remaining */
  sellPct: number;
}

export interface SwapQuote {
  chain: ChainId;
  inputMint: string;
  outputMint: string;
  inputAmountUsd: number;
  /** token units (UI amount) expected out for a buy, or USD out for a sell */
  outputAmount: number;
  effectivePriceUsd: number;
  priceImpactPct: number;
  slippageBps: number;
  minReceived: number;
  networkFeeUsd: number;
  /** false when the chain's fee could not be worked out (networkFeeUsd is then 0, not an estimate); the wallet shows the exact fee */
  networkFeeKnown?: boolean;
  priorityFeeUsd: number;
  platformFeeUsd: number;
  route: string[];
  expiresAt: Date;
  /** provider-specific payload needed to build a transaction (opaque) */
  raw?: unknown;
  source: DataSourceKind;
}
