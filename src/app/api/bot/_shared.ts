import { ApiError } from "@/lib/api";
import { collections, newId, withId } from "@/lib/db";
import { liveTradingAllowed } from "@/lib/env";
import { logEvent } from "@/lib/events";
import type { BotStatus } from "@/lib/models";
import { getSettings } from "@/services/settings";

/** Shared state transition for the bot endpoints. Never touches open positions. */
export async function setBotState(userId: string, status: BotStatus) {
  const settings = await getSettings(userId);
  if (status === "ACTIVE") {
    if (settings.environment === "MANUAL") throw new ApiError("Choose LIVE as the bot environment in Settings → Trading first", 409);
    if (!liveTradingAllowed()) throw new ApiError("LIVE trading is disabled by server configuration", 403);
  }
  const bots = await collections.bots();
  const now = new Date();
  await bots.updateOne(
    { userId },
    {
      $set: { status, updatedAt: now, ...(status === "DISABLED" ? { emergencyStoppedAt: now } : { emergencyStoppedAt: null }) },
      $setOnInsert: { _id: newId(), userId, environment: "LIVE", lastRunAt: null, createdAt: now },
    },
    { upsert: true },
  );
  const bot = await bots.findOne({ userId });
  if (!bot) throw new Error("Bot disappeared right after upsert");
  const settingsCol = await collections.tradingSettings();
  await settingsCol.updateOne({ userId }, { $set: { autoTradingEnabled: status === "ACTIVE", updatedAt: now } });
  const type = status === "ACTIVE" ? "BOT_STARTED" : status === "PAUSED" ? "BOT_PAUSED" : "BOT_STOPPED";
  await logEvent({
    type,
    source: "bot",
    userId,
    level: status === "DISABLED" ? "WARN" : "INFO",
    message:
      status === "ACTIVE" ? `Bot started (${settings.environment})` : status === "PAUSED" ? "Bot paused: no new entries; open positions keep being monitored" : "EMERGENCY STOP: no new entries. Open positions were left untouched and stay monitored",
  });
  return withId(bot);
}
