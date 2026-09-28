import type { AiAnalysis, AiInput } from "../../ai/schema";
import type { AiProvider } from "../interfaces";

export { MockChainAdapter, MockDexAdapter, MockTokenDataProvider } from "./mockMarket";

/**
 * Rules-based summariser used when no LLM key is configured. It turns the structured engine output into the
 * same JSON schema an LLM would return. It is deterministic and clearly labelled as non-LLM in the UI.
 */
export class RulesAiProvider implements AiProvider {
  readonly name = "rules-based-summary";
  readonly isLlm = false;

  async analyze(i: AiInput): Promise<AiAnalysis> {
    const pct = (n: number) => `${n >= 0 ? "+" : ""}${n.toFixed(1)}%`;
    const pressure = i.buySellRatio >= 1.3 ? "strong buying" : i.buySellRatio <= 0.8 ? "net selling" : "balanced order flow";
    const spike = i.volumeSpike !== null && i.volumeSpike >= 1.5 ? `Volume is ${i.volumeSpike.toFixed(1)}x its recent average.` : "Volume is near its recent average.";
    const liq = i.liquidityTrendPct >= 5 ? "Liquidity has been growing" : i.liquidityTrendPct <= -10 ? "Liquidity has been shrinking" : "Liquidity has remained relatively stable";
    const holders = i.holderGrowthPct1h > 0.5 ? `holder count grew ${i.holderGrowthPct1h.toFixed(1)}% in the last hour` : "holder count is flat";

    const risks: string[] = ["Low-cap asset with high volatility", ...i.criticalIssues, ...i.warnings];
    if (i.topHolderPct >= 15) risks.push(`Top holder controls ${i.topHolderPct.toFixed(1)}% of supply`);
    if (i.liquidityUsd < 150_000) risks.push("Limited liquidity — larger orders will move price");
    if (i.whaleBias === "DISTRIBUTION") risks.push("Large wallets appear to be distributing");

    const invalidation = [
      "Liquidity falls sharply or the pool becomes inactive",
      "Buy/sell ratio flips to sustained net selling",
      i.breakout ? "Price closes back below the breakout level" : "Price loses the recent support level",
    ];

    return {
      whatIsHappening: `${i.symbol} is trading at $${i.priceUsd.toPrecision(4)} (${pct(i.change5m)} 5m, ${pct(i.change1h)} 1h) with ${pressure}. ${liq} and ${holders}. ${spike}`,
      whyInteresting: `Trend is ${i.trend.toLowerCase()}${i.breakout ? " with a breakout" : i.pullback ? " with a pullback inside the trend" : ""}, whale flow is ${i.whaleBias.toLowerCase()}, and the internal opportunity score is ${i.opportunityScore.toFixed(0)}/100 (an analytical metric, not a probability of profit).`,
      recentChanges: `Over the last hour price moved ${pct(i.change1h)}; RSI is ${i.rsi14 === null ? "n/a" : i.rsi14.toFixed(0)}; liquidity changed ${pct(i.liquidityTrendPct)}.`,
      strategyFit: {
        matches: i.signalType === "BUY",
        explanation:
          i.signalType === "BUY"
            ? `Meets the configured score and risk requirements (${i.strategySummary}).`
            : `Does not fully meet BUY requirements (${i.strategySummary}); monitoring as ${i.signalType}.`,
      },
      primaryRisks: Array.from(new Set(risks)).slice(0, 8),
      invalidation,
    };
  }
}
