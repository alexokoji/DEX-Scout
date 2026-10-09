import { z } from "zod";
import type { ProfitTargetConfig } from "@/core/types";
import { deriveStatus } from "@/core/trading/positions";
import { validateTargets } from "@/core/trading/targets";
import { collections, newId } from "@/lib/db";
import { logEvent } from "@/lib/events";
import { TradeError } from "./errors";

/** A target ladder as people enter it: a gain to reach and the share of the position to sell there. Levels are assigned here. */
export const targetsInput = z
  .array(z.object({ gainPct: z.number().positive().max(1_000_000), sellPct: z.number().positive().max(100) }))
  .min(1, "At least one profit target is required")
  .max(10, "At most 10 targets");
export type TargetsInput = z.infer<typeof targetsInput>;

/** Number a ladder 1..n in ascending order of gain and check it: gains must rise, shares must make sense. Throws a 422 with the reason. */
export function toLadder(input: TargetsInput): ProfitTargetConfig[] {
  const ladder = [...input].sort((a, b) => a.gainPct - b.gainPct).map((t, i) => ({ level: i + 1, gainPct: t.gainPct, sellPct: t.sellPct }));
  const problem = validateTargets(ladder);
  if (problem) throw new TradeError(problem, 422, [problem]);
  return ladder;
}

const describe = (l: ProfitTargetConfig[]) => l.map((t) => `+${t.gainPct}% sells ${t.sellPct}%`).join(", ");

/**
 * Give ONE position its own profit targets. The settings ladder is only the default a new position starts with; after that the
 * position's own ladder is what the monitor and the auto-sell orders use, so two positions can aim at different gains.
 *
 * What is left of the position is re-planned from now: the new ladder starts again at its first target, each target's share is of
 * what is held now, and gains are still measured from the position's entry price. Targets that already sold keep their proceeds.
 * Auto-sell orders that are armed were placed at the old targets and sit with a venue, so they have to be cancelled first
 * (changing the ladder underneath them would leave orders that no longer match it); ones only suggested are discarded and rebuilt
 * from the new ladder when armed.
 */
export async function setPositionTargets(userId: string, positionId: string, input: TargetsInput) {
  const ladder = toLadder(input);
  const positions = await collections.positions();
  const pos = await positions.findOne({ _id: positionId, userId, environment: "LIVE" });
  if (!pos || pos.status === "CLOSED" || pos.amount <= 0) throw new TradeError("Position not found or already closed", 404);
  const orders = await collections.autoSellOrders();
  if (await orders.countDocuments({ positionId, status: "ACTIVE" })) {
    throw new TradeError("Auto-sell is armed for this position at its current targets. Cancel auto-sell first, change the targets, then arm it again.", 409);
  }
  const now = new Date();
  const status = deriveStatus({ closed: false, emergency: pos.status === "EMERGENCY", targetsHit: 0, unrealizedPnlUsd: pos.amount * (pos.currentPriceUsd - pos.entryPriceUsd) });
  await positions.updateOne({ _id: pos._id, status: { $ne: "CLOSED" } }, { $set: { targetsSnapshot: ladder, targetsHit: 0, initialAmount: pos.amount, status, updatedAt: now } });
  await orders.deleteMany({ positionId, userId, status: "SUGGESTED" });
  const events = await collections.positionEvents();
  await events.insertOne({ _id: newId(), positionId, type: "TARGETS_CHANGED", message: `Targets changed. Before: ${describe(pos.targetsSnapshot ?? [])}. Now: ${describe(ladder)}.`, data: { from: pos.targetsSnapshot ?? [], to: ladder }, createdAt: now });
  await logEvent({ type: "SETTINGS_UPDATED", source: "positions", userId, message: `Position targets changed: ${describe(ladder)}`, data: { positionId } });
  return { targets: ladder };
}
