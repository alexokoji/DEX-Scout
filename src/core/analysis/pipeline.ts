import { DEFAULT_WEIGHTS } from "../config";
import type { Analysis, Candle, OnChainRaw, ScoreWeights, Timeframe, TokenSnapshot } from "../types";
import { TIMEFRAME_MINUTES } from "../types";
import { analyzeMarket } from "./market";
import { analyzeOnChain } from "./onchain";
import { assessSafety } from "./safety";
import { scoreOpportunity } from "./scoring";
import { projectRise } from "./projection";
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
  // the candles at hand are the recent few hours: enough for the one-hour and four-hour figures; longer ones come from the token page
  const projection = projectRise(candles, TIMEFRAME_MINUTES[timeframe], [60, 240], now);
  return { snapshot, onchainRaw, safety, market, onchain, opportunity, trust, projection, computedAt: now };
}
