import { DEFAULT_WEIGHTS } from "../config";
import type { Analysis, Candle, OnChainRaw, ScoreWeights, Timeframe, TokenSnapshot } from "../types";
import { analyzeMarket } from "./market";
import { analyzeOnChain } from "./onchain";
import { assessSafety } from "./safety";
import { scoreOpportunity } from "./scoring";
import { assessTrust } from "./trust";

/** Pure composition of the analysis engines. I/O (candles, raw on-chain facts) is supplied by the caller. */
export function buildAnalysis(
  snapshot: TokenSnapshot,
  onchainRaw: OnChainRaw,
  candles: Candle[],
  timeframe: Timeframe = "5m",
  weights: ScoreWeights = DEFAULT_WEIGHTS,
  now = new Date(),
): Analysis {
  const safety = assessSafety(snapshot, onchainRaw);
  const market = analyzeMarket(snapshot, candles, timeframe);
  const onchain = analyzeOnChain(onchainRaw, snapshot);
  const opportunity = scoreOpportunity(snapshot, market, onchain, weights, now);
  const trust = assessTrust(snapshot, onchainRaw, now);
  return { snapshot, onchainRaw, safety, market, onchain, opportunity, trust, computedAt: now };
}
