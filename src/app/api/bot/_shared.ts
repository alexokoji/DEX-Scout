import type { BotStatus } from "@prisma/client";
import { ApiError } from "@/lib/api";
import { db } from "@/lib/db";
import { liveTradingAllowed } from "@/lib/env";
import { logEvent } from "@/lib/events";
import { getSettings } from "@/services/settings";

/** Shared state transition for the bot endpoints. Never touches open positions. */
export async function setBotState(userId: string, status: BotStatus) {
  const settings = await getSettings(userId);
  if (status === "ACTIVE") {
    if (settings.environment === "MANUAL") throw new ApiError("Choose PAPER or LIVE as the bot environment in Settings → Trading first", 409);
    if (settings.environment === "LIVE" && !liveTradingAllowed()) throw new ApiError("LIVE trading is disabled by server configuration", 403);
  }
  const bot = await db.bot.upsert({
    where: { userId },
    create: { userId, status, environment: settings.environment === "MANUAL" ? "PAPER" : settings.environment },
    update: { status, emergencyStoppedAt: status === "DISABLED" ? new Date() : null },
  });
  await db.tradingSettings.update({ where: { userId }, data: { autoTradingEnabled: status === "ACTIVE" } });
  const type = status === "ACTIVE" ? "BOT_STARTED" : status === "PAUSED" ? "BOT_PAUSED" : "BOT_STOPPED";
  await logEvent({
    type,
    source: "bot",
    userId,
    level: status === "DISABLED" ? "WARN" : "INFO",
    message:
      status === "ACTIVE" ? `Bot started (${settings.environment})` : status === "PAUSED" ? "Bot paused: no new entries; open positions keep being monitored" : "EMERGENCY STOP: no new entries. Open positions were left untouched and stay monitored",
  });
  return bot;
}