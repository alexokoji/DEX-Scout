import type { Prisma } from "@prisma/client";
import { db } from "./db";

export type EventType =
  | "SCANNER_STARTED"
  | "SCANNER_COMPLETED"
  | "TOKEN_DISCOVERED"
  | "TOKEN_FILTERED"
  | "SAFETY_CHECK_COMPLETED"
  | "ANALYSIS_COMPLETED"
  | "SIGNAL_CREATED"
  | "SIGNAL_EXPIRED"
  | "TRADE_REQUESTED"
  | "TRADE_EXECUTED"
  | "TRADE_FAILED"
  | "TRADE_SKIPPED"
  | "POSITION_OPENED"
  | "POSITION_UPDATED"
  | "TARGET_REACHED"
  | "PROFIT_TAKEN"
  | "EMERGENCY_WARNING"
  | "EMERGENCY_EXIT"
  | "POSITION_CLOSED"
  | "BOT_STARTED"
  | "BOT_PAUSED"
  | "BOT_STOPPED"
  | "BOT_RUN"
  | "SETTINGS_UPDATED"
  | "WALLET_LINKED"
  | "AUTH"
  | "PROVIDER_ERROR"
  | "WORKER_ERROR";

/** Structured audit/system log. Never throws: logging must not break the calling workflow. */
export async function logEvent(e: {
  type: EventType;
  source: string;
  message: string;
  level?: "DEBUG" | "INFO" | "WARN" | "ERROR";
  userId?: string | null;
  data?: Prisma.InputJsonValue;
}): Promise<void> {
  try {
    await db.systemEvent.create({
      data: {
        type: e.type,
        source: e.source,
        message: e.message.slice(0, 500),
        level: e.level ?? "INFO",
        userId: e.userId ?? null,
        data: e.data,
      },
    });
  } catch (err) {
    console.error("[events] failed to write system event", e.type, err instanceof Error ? err.message : err);
  }
}

/** Convert an unknown error into a message that is safe to show users (no stack traces / secrets). */
export function safeMessage(err: unknown, fallback = "Unexpected error"): string {
  if (err instanceof Error) {
    const m = err.message.replace(/(api[-_ ]?key|token|secret)=[^&\s]+/gi, "$1=***");
    return m.length > 300 ? m.slice(0, 300) + "…" : m;
  }
  return fallback;
}
