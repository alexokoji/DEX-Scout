import type { Position, Token } from "@prisma/client";
import { providers } from "@/core/providers/registry";
import { assessPosition } from "@/core/trading/emergency";
import { deriveStatus } from "@/core/trading/positions";
import { evaluateTargets } from "@/core/trading/targets";
import type { ChainId, ProfitTargetConfig } from "@/core/types";
import { db } from "@/lib/db";
import { liveTradingAllowed } from "@/lib/env";
import { logEvent, safeMessage } from "@/lib/events";
import { analyzeSnapshot } from "./analysis";
import { getSettings } from "./settings";
import { paperSell, prepareLiveSell } from "./trading";
import { touchWorker } from "./workerState";

type PositionWithToken = Position & { token: Token };

interface HealthNotes {
  entryLiquidityUsd?: number;
  positives?: string[];
  negatives?: string[];
  emergencyReasons?: string[];
  maxAgeNoted?: boolean;
}

/**
 * Re-evaluate every open position: refresh price, re-run analysis, update health, take configured profits and,
 * only if the user enabled it, react to catastrophic emergency conditions.
 *
 * A position that is merely losing is never sold here — there is no stop-loss code path.
 */
export async function monitorPosition(pos: PositionWithToken): Promise<void> {
  const p = providers();
  const settings = await getSettings(pos.userId);
  const notes = (pos.healthNotes ?? {}) as HealthNotes;

  const snap = await p.data.getSnapshot(pos.token.chain as ChainId, pos.token.address).catch(() => null);
  const raw = snap ? await p.data.getOnChain(pos.token.chain as ChainId, pos.token.address, snap).catch(() => null) : null;
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
  const status = deriveStatus({ closed: false, emergency: assessment.health === "EMERGENCY", targetsHit: pos.targetsHit, unrealizedPnlUsd: unrealized });

  await db.position.update({
    where: { id: pos.id },
    data: {
      currentPriceUsd: price,
      health: assessment.health,
      status,
      lastAnalysisAt: new Date(),
      healthNotes: {
        ...notes,
        positives: assessment.positives,
        negatives: assessment.negatives,
        emergencyReasons: assessment.emergencyReasons,
      },
    },
  });

  if (assessment.health !== pos.health && (assessment.health === "WARNING" || assessment.health === "EMERGENCY")) {
    const why = [...assessment.emergencyReasons, ...assessment.negatives].join("; ");
    await db.positionEvent.create({ data: { positionId: pos.id, type: "HEALTH_" + assessment.health, message: `Health → ${assessment.health}: ${why}` } });
    await logEvent({ type: "EMERGENCY_WARNING", source: "monitor", userId: pos.userId, level: "WARN", message: `${pos.token.symbol} health ${assessment.health}: ${why}`, data: { positionId: pos.id } });
  } else if (assessment.health !== pos.health) {
    await db.positionEvent.create({ data: { positionId: pos.id, type: "HEALTH_" + assessment.health, message: `Health → ${assessment.health}` } });
  }

  // ── Emergency exit (separate from profit-taking; opt-in) ──
  if (assessment.emergency && pos.emergencyAutoExit) {
    const reason = `Emergency exit: ${assessment.emergencyReasons.join("; ")}`;
    if (pos.environment === "PAPER") {
      await paperSell(pos.userId, pos.id, pos.amount, "EMERGENCY_EXIT", reason);
    } else if (liveTradingAllowed()) {
      await prepareLiveSell(pos.userId, pos.id, pos.amount, "EMERGENCY_EXIT", reason);
    }
    return;
  }

  // ── Profit targets ──
  if (!snap) return;
  const targets = (pos.targetsSnapshot as unknown as ProfitTargetConfig[]) ?? [];
  const actions = evaluateTargets(
    { entryPriceUsd: pos.entryPriceUsd, initialAmount: pos.initialAmount, amount: pos.amount, costBasisUsd: pos.costBasisUsd, targetsHit: pos.targetsHit },
    price,
    targets,
  );
  if (actions.length) {
    await logEvent({ type: "TARGET_REACHED", source: "monitor", userId: pos.userId, message: `${pos.token.symbol} reached target ${actions.map((a) => a.level).join(",")}`, data: { positionId: pos.id } });
    if (pos.environment === "PAPER") {
      for (const a of actions) {
        const r = await paperSell(pos.userId, pos.id, a.sellAmount, "TARGET_EXIT", `Target ${a.level} (+${a.gainPct}%)`, a.level);
        if (!r.ok) break; // retry on the next tick
      }
    } else if (liveTradingAllowed()) {
      const total = actions.reduce((s, a) => s + a.sellAmount, 0);
      await prepareLiveSell(pos.userId, pos.id, total, "TARGET_EXIT", `Target ${actions[actions.length - 1].level} reached`, actions[actions.length - 1].level);
    }
    return;
  }

  // ── Max position age: only ever closes a position that is in profit; losers are held (no stop loss) ──
  if (settings.maxPositionAgeHours && Date.now() - pos.openedAt.getTime() > settings.maxPositionAgeHours * 3_600_000) {
    if (unrealized > 0) {
      if (pos.environment === "PAPER") await paperSell(pos.userId, pos.id, pos.amount, "TARGET_EXIT", "Maximum position age reached while in profit");
      else if (liveTradingAllowed()) await prepareLiveSell(pos.userId, pos.id, pos.amount, "TARGET_EXIT", "Maximum position age reached while in profit");
    } else if (!notes.maxAgeNoted) {
      await db.positionEvent.create({ data: { positionId: pos.id, type: "MAX_AGE", message: "Maximum age reached but position is not in profit — holding (no automatic stop loss)" } });
      await db.position.update({ where: { id: pos.id }, data: { healthNotes: { ...notes, positives: assessment.positives, negatives: assessment.negatives, emergencyReasons: assessment.emergencyReasons, maxAgeNoted: true } } });
    }
  }
}

export async function runPositionMonitorCycle(): Promise<{ monitored: number; errors: number }> {
  const positions = await db.position.findMany({ where: { status: { not: "CLOSED" }, amount: { gt: 0 } }, include: { token: true } });
  let errors = 0;
  for (const pos of positions) {
    try {
      await monitorPosition(pos);
    } catch (err) {
      errors++;
      await logEvent({ type: "WORKER_ERROR", source: "monitor", level: "ERROR", userId: pos.userId, message: `Monitoring ${pos.token.symbol} failed: ${safeMessage(err)}`, data: { positionId: pos.id } });
    }
  }
  await touchWorker("position-monitor-worker", errors && errors === positions.length ? "All position checks failed" : null, { monitored: positions.length, errors });
  return { monitored: positions.length, errors };
}
