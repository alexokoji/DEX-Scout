import { providers } from "@/core/providers/registry";
import { assessPosition } from "@/core/trading/emergency";
import { deriveStatus } from "@/core/trading/positions";
import { evaluateTargets } from "@/core/trading/targets";
import type { ChainId } from "@/core/types";
import { collections, newId } from "@/lib/db";
import { liveTradingAllowed } from "@/lib/env";
import { logEvent, safeMessage } from "@/lib/events";
import type { PositionDoc, TokenDoc } from "@/lib/models";
import { analyzeSnapshot } from "./analysis";
import { getSettings } from "./settings";
import { checkScannerHealth, notifyUser } from "./notifications";
import { positionAlert } from "./notificationMessages";
import { activeAutoSellLevels, syncAutoSells } from "./autoSell";
import { prepareLiveSell } from "./trading";
import { touchWorker } from "./workerState";

interface HealthNotes {
  entryLiquidityUsd?: number;
  positives?: string[];
  negatives?: string[];
  emergencyReasons?: string[];
  maxAgeNoted?: boolean;
}

/**
 * Re-evaluate one open position: refresh price, re-run analysis, update health, take configured profits and,
 * only if the user enabled it, react to catastrophic emergency conditions.
 *
 * A position that is merely losing is never sold here — there is no stop-loss code path.
 */
export async function monitorPosition(pos: PositionDoc, token: TokenDoc): Promise<void> {
  const p = providers();
  const settings = await getSettings(pos.userId);
  const notes = (pos.healthNotes ?? {}) as HealthNotes;
  const positions = await collections.positions();
  const positionEvents = await collections.positionEvents();

  const snap = await p.data.getSnapshot(token.chain as ChainId, token.address).catch(() => null);
  const raw = snap ? await p.data.getOnChain(token.chain as ChainId, token.address, snap).catch(() => null) : null;
  const analysis = snap && raw ? await analyzeSnapshot(snap, raw) : null;

  const price = snap?.priceUsd ?? pos.currentPriceUsd;
  const assessment = assessPosition(
    {
      snapshot: snap,
      raw,
      safety: analysis?.safety ?? null,
      market: analysis?.market ?? null,
      onchain: analysis?.onchain ?? null,
      liquidityAtEntryUsd: notes.entryLiquidityUsd ?? 0,
      positionValueUsd: pos.amount * price,
    },
    { enabled: pos.emergencyEnabled, liquidityDropPct: settings.emergencyLiquidityDropPct },
  );

  const unrealized = pos.amount * price - pos.costBasisUsd;
  // "profitable" is judged on price, the way the targets and the headline P&L are; `unrealized` (after buy fees) is what a sale would net
  const status = deriveStatus({ closed: false, emergency: assessment.health === "EMERGENCY", targetsHit: pos.targetsHit, unrealizedPnlUsd: pos.amount * (price - pos.entryPriceUsd) });

  await positions.updateOne(
    { _id: pos._id },
    {
      $set: {
        currentPriceUsd: price,
        ...(snap ? { priceAt: new Date() } : {}),
        health: assessment.health,
        status,
        lastAnalysisAt: new Date(),
        healthNotes: { ...notes, positives: assessment.positives, negatives: assessment.negatives, emergencyReasons: assessment.emergencyReasons },
      },
    },
  );

  if (assessment.health !== pos.health && (assessment.health === "WARNING" || assessment.health === "EMERGENCY")) {
    const why = [...assessment.emergencyReasons, ...assessment.negatives].join("; ");
    await positionEvents.insertOne({ _id: newId(), positionId: pos._id, type: "HEALTH_" + assessment.health, message: `Health → ${assessment.health}: ${why}`, data: null, createdAt: new Date() });
    await logEvent({ type: "EMERGENCY_WARNING", source: "monitor", userId: pos.userId, level: "WARN", message: `${token.symbol} health ${assessment.health}: ${why}`, data: { positionId: pos._id } });
    await notifyUser(pos.userId, positionAlert(assessment.health, token.symbol, why, pos._id));
  } else if (assessment.health !== pos.health) {
    await positionEvents.insertOne({ _id: newId(), positionId: pos._id, type: "HEALTH_" + assessment.health, message: `Health → ${assessment.health}`, data: null, createdAt: new Date() });
  }

  // ── Emergency exit (separate from profit-taking; opt-in) ──
  if (assessment.emergency && pos.emergencyAutoExit) {
    const reason = `Emergency exit: ${assessment.emergencyReasons.join("; ")}`;
    if (liveTradingAllowed()) await prepareLiveSell(pos.userId, pos._id, pos.amount, "EMERGENCY_EXIT", reason);
    return;
  }

  // ── Profit targets ──
  if (!snap) return;
  const targets = pos.targetsSnapshot ?? [];
  // Targets covered by an armed auto-sell order are the order's job: queueing a second sell for them would double-sell
  // (and on Solana the tokens sit in escrow). Only what no order covers is queued for the user to sign.
  const covered = await activeAutoSellLevels(pos._id);
  const actions = evaluateTargets(
    { entryPriceUsd: pos.entryPriceUsd, initialAmount: pos.initialAmount, amount: pos.amount, costBasisUsd: pos.costBasisUsd, targetsHit: pos.targetsHit },
    price,
    targets,
  ).filter((a) => !covered.has(a.level));
  if (actions.length) {
    await logEvent({ type: "TARGET_REACHED", source: "monitor", userId: pos.userId, message: `${token.symbol} reached target ${actions.map((a) => a.level).join(",")}`, data: { positionId: pos._id } });
    if (liveTradingAllowed()) {
      const total = actions.reduce((s, a) => s + a.sellAmount, 0);
      await prepareLiveSell(pos.userId, pos._id, total, "TARGET_EXIT", `Target ${actions[actions.length - 1].level} reached`, actions[actions.length - 1].level);
    }
    return;
  }

  // ── Max position age: only ever closes a position that is in profit; losers are held (no stop loss) ──
  if (covered.size === 0 && settings.maxPositionAgeHours && Date.now() - pos.openedAt.getTime() > settings.maxPositionAgeHours * 3_600_000) {
    if (unrealized > 0) {
      if (liveTradingAllowed()) await prepareLiveSell(pos.userId, pos._id, pos.amount, "TARGET_EXIT", "Maximum position age reached while in profit");
    } else if (!notes.maxAgeNoted) {
      await positionEvents.insertOne({ _id: newId(), positionId: pos._id, type: "MAX_AGE", message: "Maximum age reached but position is not in profit — holding (no automatic stop loss)", data: null, createdAt: new Date() });
      await positions.updateOne(
        { _id: pos._id },
        { $set: { healthNotes: { ...notes, positives: assessment.positives, negatives: assessment.negatives, emergencyReasons: assessment.emergencyReasons, maxAgeNoted: true } } },
      );
    }
  }
}

export async function runPositionMonitorCycle(): Promise<{ monitored: number; errors: number }> {
  // book any auto-sell fills first, so the target logic below sees the position as it really is
  await syncAutoSells().catch((err) => logEvent({ type: "WORKER_ERROR", source: "monitor", level: "WARN", message: `Auto-sell sync failed: ${safeMessage(err)}` }));
  const positionsCol = await collections.positions();
  const tokensCol = await collections.tokens();
  const positions = await positionsCol.find({ status: { $ne: "CLOSED" }, amount: { $gt: 0 } }).toArray();
  const tokens = await tokensCol.find({ _id: { $in: [...new Set(positions.map((p) => p.tokenId))] } }).toArray();
  const tokenById = new Map(tokens.map((t) => [t._id, t]));

  let errors = 0;
  for (const pos of positions) {
    const token = tokenById.get(pos.tokenId);
    if (!token) continue; // token record missing — nothing sensible to do until the scanner sees it again
    try {
      await monitorPosition(pos, token);
    } catch (err) {
      errors++;
      await logEvent({ type: "WORKER_ERROR", source: "monitor", level: "ERROR", userId: pos.userId, message: `Monitoring ${token.symbol} failed: ${safeMessage(err)}`, data: { positionId: pos._id } });
    }
  }
  // the monitor is its own cron job, so it still runs (and can say so) when the scan job has died
  await checkScannerHealth().catch(() => {});
  await touchWorker("position-monitor-worker", errors && errors === positions.length ? "All position checks failed" : null, { monitored: positions.length, errors });
  return { monitored: positions.length, errors };
}
