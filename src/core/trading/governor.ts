/**
 * The daily governor: decides, from what the bot has done today, whether it may OPEN another trade. Pure; nothing here trades.
 *
 * It exists because a daily profit target is a goal, not an obligation, and a bot that is told to chase one will, left alone, trade harder
 * the further behind it is. So every rule here is a limit on risk, and the target only decides how the day is protected once it is reached:
 *
 *   CHASING        below the target, inside the loss budget: trading normally.
 *   ABOVE_TARGET   target reached: keeps taking profits and may go beyond it, with a floor under the day (see `givebackPct`).
 *   TARGET_LOCKED  target reached, then today's profit fell back to the floor: stops for the day with most of the target banked.
 *   LOSS_LIMIT     today's result (banked + what open positions are down) reached the loss budget: stops opening for the day.
 *   COOLDOWN       too many losing closes in a row: pauses for a while.
 *   OFF            autonomous trading isn't switched on.
 *
 * Stopping only ever means "no NEW positions". Open positions keep their sell targets (this app never sells a position just for being
 * down); the day resets at the start of the next one.
 */
export interface AutonomousSettings {
  enabled: boolean;
  /** the day's profit goal, in USD, net of fees */
  dailyTargetUsd: number;
  /** stop opening for the day when today's result (banked, plus what open positions are down) is this far below zero */
  dailyLossLimitUsd: number;
  /**
   * after the target is reached: how much of it (as a % of the target) the day's profit may fall back from its peak before the bot stops
   * for the day. 0 = stop as soon as the target is reached; the floor rises as the peak does, so what is made beyond the target is protected too.
   */
  givebackPct: number;
  /** pause after this many losing closes in a row */
  maxConsecutiveLosses: number;
  /** how long that pause lasts */
  cooldownMinutes: number;
  /** the bot buys only while the price is in the lowest this-many % of its recent range (and not rising): a dip, not a climb. See core/analysis/entryTiming.ts */
  entryMaxRangePct: number;
  /** when the day starts, as minutes east of UTC (e.g. 60 = the day starts at 01:00 UTC); 0 = midnight UTC */
  dayOffsetMinutes: number;
}

/** What one of today's bot transactions did to the result, net of its fees: a sale's profit or loss less its fees, or a buy's fees alone. */
export interface DayEvent {
  at: Date;
  netUsd: number;
  /** a sale that closed its position (the unit "losing closes in a row" is counted in) */
  closed: boolean;
}

export type GovernorState = "OFF" | "CHASING" | "ABOVE_TARGET" | "TARGET_LOCKED" | "LOSS_LIMIT" | "COOLDOWN";

export interface GovernorDecision {
  state: GovernorState;
  canOpen: boolean;
  /** one plain sentence for the person watching */
  reason: string;
  /** what the day has banked so far, net of fees */
  realizedUsd: number;
  /** what open positions are down right now (0 or negative): counts against the loss budget, never toward the target */
  openDrawdownUsd: number;
  /** the best the day's banked result has been */
  peakUsd: number;
  /** once the target is reached, the result below which the bot stops for the day; null before that */
  floorUsd: number | null;
  targetUsd: number;
  lossLimitUsd: number;
  consecutiveLosses: number;
  cooldownUntil: Date | null;
}

/** When the day that contains `now` started. */
export function dayStart(now: Date, dayOffsetMinutes: number): Date {
  const shift = dayOffsetMinutes * 60_000;
  const day = 24 * 3_600_000;
  return new Date(Math.floor((now.getTime() - shift) / day) * day + shift);
}

const usd = (n: number) => `${n < 0 ? "-" : ""}$${Math.abs(n).toFixed(2)}`;

export function evaluateDay(s: AutonomousSettings, events: DayEvent[], openUnrealizedUsd: number[], now: Date): GovernorDecision {
  const sorted = [...events].sort((a, b) => a.at.getTime() - b.at.getTime());
  let realized = 0;
  let peak = 0;
  let targetReachedAt = -1; // index of the event that first took the banked result to the target
  sorted.forEach((e, i) => {
    realized += e.netUsd;
    peak = Math.max(peak, realized);
    if (targetReachedAt < 0 && realized >= s.dailyTargetUsd) targetReachedAt = i;
  });
  const openDrawdown = openUnrealizedUsd.reduce((sum, u) => sum + Math.min(0, u), 0);
  const closes = sorted.filter((e) => e.closed);
  let consecutiveLosses = 0;
  for (let i = closes.length - 1; i >= 0 && closes[i].netUsd < 0; i--) consecutiveLosses++;
  const lastCloseAt = closes.length ? closes[closes.length - 1].at : null;

  const base = { realizedUsd: realized, openDrawdownUsd: openDrawdown, peakUsd: peak, targetUsd: s.dailyTargetUsd, lossLimitUsd: s.dailyLossLimitUsd, consecutiveLosses, floorUsd: null as number | null, cooldownUntil: null as Date | null };
  const stop = (state: GovernorState, reason: string, extra: Partial<typeof base> = {}): GovernorDecision => ({ ...base, ...extra, state, canOpen: false, reason });

  if (!s.enabled) return stop("OFF", "Unattended trading is switched off.");

  // once the target has been reached (at any point today), the day has a floor: the peak less the giveback allowance
  const reached = targetReachedAt >= 0;
  const floor = reached ? peak - (s.dailyTargetUsd * s.givebackPct) / 100 : null;

  if (reached && floor !== null && realized <= floor) {
    return stop("TARGET_LOCKED", `The ${usd(s.dailyTargetUsd)} target was reached (the day's best was ${usd(peak)}) and today's profit is now ${usd(realized)}, at the floor of ${usd(floor)}: no new trades until tomorrow, with the day's gains protected.`, { floorUsd: floor });
  }
  if (realized + openDrawdown <= -s.dailyLossLimitUsd) {
    return stop("LOSS_LIMIT", `Today's result is ${usd(realized + openDrawdown)} (${usd(realized)} banked, ${usd(openDrawdown)} on open positions), which reaches the ${usd(s.dailyLossLimitUsd)} loss limit: no new trades until tomorrow. Open positions keep their sell targets.`, { floorUsd: floor });
  }
  if (s.maxConsecutiveLosses > 0 && consecutiveLosses >= s.maxConsecutiveLosses && lastCloseAt) {
    const until = new Date(lastCloseAt.getTime() + s.cooldownMinutes * 60_000);
    if (until.getTime() > now.getTime()) {
      return stop("COOLDOWN", `${consecutiveLosses} losing closes in a row: paused until ${until.toISOString().slice(11, 16)} UTC.`, { floorUsd: floor, cooldownUntil: until });
    }
  }
  if (reached) {
    return { ...base, floorUsd: floor, state: "ABOVE_TARGET", canOpen: true, reason: `Target of ${usd(s.dailyTargetUsd)} reached (${usd(realized)} banked). Still trading, and it stops if profit falls back to ${usd(floor ?? s.dailyTargetUsd)}.` };
  }
  return { ...base, state: "CHASING", canOpen: true, reason: `${usd(realized)} of the ${usd(s.dailyTargetUsd)} target banked today. Trading within a ${usd(s.dailyLossLimitUsd)} loss limit.` };
}
