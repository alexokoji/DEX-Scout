/**
 * The daily governor: a profit target is a goal, not an obligation, so every rule here limits risk and the target only decides how the
 * day is protected once it is reached. These pin each state and the moments the day changes state.
 */
import { describe, expect, it } from "vitest";
import { dayStart, evaluateDay, type AutonomousSettings, type DayEvent } from "@/core/trading/governor";

const S: AutonomousSettings = { enabled: true, dailyTargetUsd: 10, dailyLossLimitUsd: 5, givebackPct: 30, maxConsecutiveLosses: 3, cooldownMinutes: 30, entryMaxRangePct: 35, dayOffsetMinutes: 0 };
const T0 = new Date("2026-10-10T08:00:00Z").getTime();
const at = (min: number) => new Date(T0 + min * 60_000);
const win = (min: number, netUsd: number): DayEvent => ({ at: at(min), netUsd, closed: true });
const loss = (min: number, netUsd: number): DayEvent => ({ at: at(min), netUsd: -Math.abs(netUsd), closed: true });
const fee = (min: number, usd = 0.01): DayEvent => ({ at: at(min), netUsd: -usd, closed: false });
const now = at(600);

describe("the day starts out chasing the target", () => {
  it("off means off", () => {
    expect(evaluateDay({ ...S, enabled: false }, [], [], now)).toMatchObject({ state: "OFF", canOpen: false });
  });
  it("an empty day is open for trading, with nothing banked", () => {
    const d = evaluateDay(S, [], [], now);
    expect(d).toMatchObject({ state: "CHASING", canOpen: true, realizedUsd: 0 });
  });
  it("buys count against the day through their fees, so a day of buys and no sales is slightly down, not flat", () => {
    const d = evaluateDay(S, [fee(1, 0.02), fee(2, 0.03)], [], now);
    expect(d.realizedUsd).toBeCloseTo(-0.05, 10);
    expect(d.canOpen).toBe(true);
  });
});

describe("once the target is reached the bot keeps going, with a floor under the day", () => {
  it("below the target it is chasing; at the target it carries on above it", () => {
    expect(evaluateDay(S, [win(1, 9)], [], now).state).toBe("CHASING");
    const d = evaluateDay(S, [win(1, 12)], [], now);
    expect(d).toMatchObject({ state: "ABOVE_TARGET", canOpen: true, peakUsd: 12 });
    expect(d.floorUsd).toBeCloseTo(9, 10); // the peak (12) less 30% of the target (3)
  });
  it("it stops for the day when profit falls back to the floor, and the floor rises with the peak", () => {
    expect(evaluateDay(S, [win(1, 12), loss(2, 3)], [], now)).toMatchObject({ state: "TARGET_LOCKED", canOpen: false, realizedUsd: 9 });
    expect(evaluateDay(S, [win(1, 12), loss(2, 2.9)], [], now).canOpen).toBe(true); // still above the floor
    const higher = evaluateDay(S, [win(1, 12), win(2, 3), loss(3, 2.9)], [], now); // peak 15, floor 12, now 12.1
    expect(higher.canOpen).toBe(true);
    expect(higher.floorUsd).toBeCloseTo(12, 10);
    expect(evaluateDay(S, [win(1, 12), win(2, 3), loss(3, 3)], [], now)).toMatchObject({ state: "TARGET_LOCKED", canOpen: false });
  });
  it("with no giveback allowed it stops the moment the target is reached", () => {
    expect(evaluateDay({ ...S, givebackPct: 0 }, [win(1, 10)], [], now)).toMatchObject({ state: "TARGET_LOCKED", canOpen: false });
  });
  it("having fallen back under the target after reaching it does not make it chase the target again", () => {
    const d = evaluateDay(S, [win(1, 11), loss(2, 5)], [], now); // 6 banked, the floor is 8
    expect(d.state).toBe("TARGET_LOCKED");
  });
});

describe("the loss limit protects the day when the target can't be reached", () => {
  it("banked losses and what open positions are down add up against the limit; open gains don't offset them", () => {
    expect(evaluateDay(S, [loss(1, 3)], [-1.9], now).canOpen).toBe(true); // 4.9 down
    expect(evaluateDay(S, [loss(1, 3)], [-2], now)).toMatchObject({ state: "LOSS_LIMIT", canOpen: false });
    expect(evaluateDay(S, [loss(1, 3)], [-2, +50], now).state).toBe("LOSS_LIMIT"); // a gain elsewhere doesn't make the day safe: it isn't banked
    expect(evaluateDay(S, [], [-5], now).state).toBe("LOSS_LIMIT");
  });
  it("says why, and that open positions keep their targets", () => {
    expect(evaluateDay(S, [], [-5], now).reason).toMatch(/sell targets/);
  });
});

describe("a run of losing closes pauses the bot for a while", () => {
  it("three in a row pause it until the cooldown passes", () => {
    const events = [loss(1, 0.2), loss(2, 0.2), loss(3, 0.2)];
    const d = evaluateDay(S, events, [], at(10));
    expect(d).toMatchObject({ state: "COOLDOWN", canOpen: false, consecutiveLosses: 3 });
    expect(d.cooldownUntil!.getTime()).toBe(at(33).getTime());
    expect(evaluateDay(S, events, [], at(34))).toMatchObject({ state: "CHASING", canOpen: true });
  });
  it("a win in between breaks the run", () => {
    expect(evaluateDay(S, [loss(1, 0.2), loss(2, 0.2), win(3, 0.5), loss(4, 0.2)], [], at(10))).toMatchObject({ canOpen: true, consecutiveLosses: 1 });
  });
  it("buys' fees don't count as losing closes", () => {
    expect(evaluateDay(S, [fee(1), fee(2), fee(3), fee(4)], [], at(10)).consecutiveLosses).toBe(0);
  });
  it("0 turns the pause off", () => {
    expect(evaluateDay({ ...S, maxConsecutiveLosses: 0 }, [loss(1, 1), loss(2, 1), loss(3, 1), loss(4, 1)], [], at(10)).canOpen).toBe(true);
  });
});

describe("when a day starts", () => {
  it("at midnight UTC by default, or shifted by the offset", () => {
    const t = new Date("2026-10-10T08:30:00Z");
    expect(dayStart(t, 0).toISOString()).toBe("2026-10-10T00:00:00.000Z");
    expect(dayStart(t, 60).toISOString()).toBe("2026-10-10T01:00:00.000Z");
    expect(dayStart(new Date("2026-10-10T00:30:00Z"), 60).toISOString()).toBe("2026-10-09T01:00:00.000Z"); // before the shifted day starts: still yesterday's
    expect(dayStart(t, -120).toISOString()).toBe("2026-10-09T22:00:00.000Z");
  });
});
