/**
 * Backtesting foundation. A Strategy decides entries from historical bars; the engine replays bars, applies the
 * same profit-target logic used live (no stop loss), and reports basic performance statistics.
 *
 * Backtest results describe how a rule set behaved on past data. They do NOT prove or predict future profitability.
 */
import type { ProfitTargetConfig } from "../types";
import { evaluateTargets, type PositionState } from "../trading/targets";
import { applySell } from "../trading/positions";

export interface HistoricalBar {
  time: number; // unix seconds
  price: number;
  volume: number;
  liquidityUsd: number;
}

export interface Strategy {
  name: string;
  /** Return true to enter at this bar. `history` contains bars up to and including `i`. */
  shouldEnter(history: HistoricalBar[]): boolean;
}

export interface BacktestConfig {
  capitalUsd: number;
  positionUsd: number;
  maxOpenPositions: number;
  targets: ProfitTargetConfig[];
  feeBps: number;
  /** close any positions still open at the last bar for reporting (mark-to-market) */
  markToMarketAtEnd: boolean;
}

export interface BacktestTrade {
  entryTime: number;
  exitTime: number | null;
  entryPrice: number;
  investedUsd: number;
  realizedPnlUsd: number;
  closed: boolean;
  holdBars: number;
}

export interface BacktestResult {
  trades: BacktestTrade[];
  totalPnlUsd: number;
  winRate: number;
  avgHoldBars: number;
  maxDrawdownPct: number;
  capitalUtilization: number;
  openAtEnd: number;
  disclaimer: string;
}

interface OpenPos extends PositionState {
  realizedPnlUsd: number;
  entryIndex: number;
  invested: number;
}

export function runBacktest(bars: HistoricalBar[], strat: Strategy, cfg: BacktestConfig): BacktestResult {
  let cash = cfg.capitalUsd;
  const open: OpenPos[] = [];
  const done: BacktestTrade[] = [];
  let peak = cfg.capitalUsd;
  let maxDd = 0;
  let deployedBarSum = 0;

  const equity = (price: number) => cash + open.reduce((s, p) => s + p.amount * price, 0);

  for (let i = 0; i < bars.length; i++) {
    const bar = bars[i];
    for (let pi = open.length - 1; pi >= 0; pi--) {
      const p = open[pi];
      for (const a of evaluateTargets(p, bar.price, cfg.targets)) {
        const gross = a.sellAmount * bar.price;
        const net = gross * (1 - cfg.feeBps / 10_000);
        const r = applySell(p, a.sellAmount, net);
        cash += net;
        p.amount = r.amount;
        p.costBasisUsd = r.costBasisUsd;
        p.realizedPnlUsd = r.realizedPnlUsd;
        p.targetsHit += 1;
        if (r.closed) {
          done.push({
            entryTime: bars[p.entryIndex].time,
            exitTime: bar.time,
            entryPrice: p.entryPriceUsd,
            investedUsd: p.invested,
            realizedPnlUsd: p.realizedPnlUsd,
            closed: true,
            holdBars: i - p.entryIndex,
          });
          open.splice(pi, 1);
          break;
        }
      }
    }

    if (open.length < cfg.maxOpenPositions && cash >= cfg.positionUsd && strat.shouldEnter(bars.slice(0, i + 1))) {
      const invest = cfg.positionUsd;
      const amount = (invest * (1 - cfg.feeBps / 10_000)) / bar.price;
      cash -= invest;
      open.push({
        entryPriceUsd: bar.price,
        initialAmount: amount,
        amount,
        costBasisUsd: invest,
        targetsHit: 0,
        realizedPnlUsd: 0,
        entryIndex: i,
        invested: invest,
      });
    }

    const eq = equity(bar.price);
    peak = Math.max(peak, eq);
    maxDd = Math.max(maxDd, peak > 0 ? ((peak - eq) / peak) * 100 : 0);
    deployedBarSum += open.reduce((s, p) => s + p.costBasisUsd, 0) / cfg.capitalUsd;
  }

  const last = bars[bars.length - 1];
  for (const p of open) {
    const mtm = cfg.markToMarketAtEnd && last ? p.amount * last.price - p.costBasisUsd : 0;
    done.push({
      entryTime: bars[p.entryIndex].time,
      exitTime: null,
      entryPrice: p.entryPriceUsd,
      investedUsd: p.invested,
      realizedPnlUsd: p.realizedPnlUsd + mtm,
      closed: false,
      holdBars: bars.length - 1 - p.entryIndex,
    });
  }

  const closed = done.filter((t) => t.closed);
  const wins = closed.filter((t) => t.realizedPnlUsd > 0).length;
  return {
    trades: done,
    totalPnlUsd: done.reduce((s, t) => s + t.realizedPnlUsd, 0),
    winRate: closed.length ? wins / closed.length : 0,
    avgHoldBars: done.length ? done.reduce((s, t) => s + t.holdBars, 0) / done.length : 0,
    maxDrawdownPct: maxDd,
    capitalUtilization: bars.length ? deployedBarSum / bars.length : 0,
    openAtEnd: open.length,
    disclaimer: "Backtests describe past behaviour of a rule set and do not prove or predict future profitability.",
  };
}
