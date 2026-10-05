import { z } from "zod";
import { collections, newId, withIds } from "@/lib/db";
import { logEvent, safeMessage } from "@/lib/events";
import type { NotificationDoc } from "@/lib/models";
import { scannerOffline, CATEGORY_OF, NOTIFICATION_CATEGORIES, type NotificationCategory } from "./notificationMessages";

/**
 * Notifications. Every one is recorded in-app (the bell, which also raises a browser notification while the app is
 * open). On top of that a user can add free off-device channels so a queued sell reaches their phone even when the app
 * is closed: ntfy.sh (no account — subscribe to a topic in the ntfy app) and/or a Discord webhook. Both hosts are
 * fixed here, so a saved value can never make the server call an arbitrary URL.
 */

const NTFY_TOPIC = /^[A-Za-z0-9_-]{8,64}$/;
const DISCORD_WEBHOOK = /^https:\/\/(discord|discordapp)\.com\/api\/webhooks\/\d+\/[\w-]+$/;

export const notificationPrefsInput = z.object({
  muted: z.array(z.enum(NOTIFICATION_CATEGORIES as [NotificationCategory, ...NotificationCategory[]])).default([]),
  ntfyTopic: z.string().trim().regex(NTFY_TOPIC, "Use 8-64 letters, numbers, - or _ (pick something hard to guess)").nullable(),
  discordWebhook: z.string().trim().regex(DISCORD_WEBHOOK, "Must be a https://discord.com/api/webhooks/… URL").nullable(),
});
export type NotificationPrefsInput = z.input<typeof notificationPrefsInput>;
export type NotificationPrefs = { ntfyTopic: string | null; discordWebhook: string | null; muted: NotificationCategory[] };

export async function getNotificationPrefs(userId: string): Promise<NotificationPrefs> {
  const row = await (await collections.notificationPrefs()).findOne({ _id: userId });
  return { ntfyTopic: row?.ntfyTopic ?? null, discordWebhook: row?.discordWebhook ?? null, muted: (row?.muted ?? []).filter((c): c is NotificationCategory => (NOTIFICATION_CATEGORIES as readonly string[]).includes(c)) };
}

export async function saveNotificationPrefs(userId: string, input: NotificationPrefsInput): Promise<NotificationPrefs> {
  await (await collections.notificationPrefs()).updateOne(
    { _id: userId },
    { $set: { ntfyTopic: input.ntfyTopic || null, discordWebhook: input.discordWebhook || null, muted: input.muted ?? [], updatedAt: new Date() } },
    { upsert: true },
  );
  return getNotificationPrefs(userId);
}

export interface NotifyInput {
  type: NotificationDoc["type"];
  /** ntfy priority; things needing you are "high", emergencies "urgent", the rest "default" */
  priority?: "urgent" | "high" | "default";
  title: string;
  body: string;
  /** in-app path */
  url: string;
  tradeId?: string | null;
  /** suppress repeats of the same thing for `remindAfterMin` (default 60) */
  dedupeKey?: string;
  remindAfterMin?: number;
}

const appUrl = (path: string) => `${(process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000").replace(/\/$/, "")}${path}`;
// HTTP header values must be Latin-1; titles go in a header for ntfy, so keep them plain ASCII there.
const ascii = (s: string) => s.replace(/[^\x20-\x7E]/g, "").trim();

async function post(url: string, init: RequestInit): Promise<void> {
  const res = await fetch(url, { ...init, method: "POST", signal: AbortSignal.timeout(5_000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
}

/** Push to the user's configured channels. Each channel fails independently and quietly. Returns what was attempted. */
export async function pushToChannels(userId: string, n: NotifyInput): Promise<{ channel: string; ok: boolean; error?: string }[]> {
  const prefs = await getNotificationPrefs(userId);
  const jobs: Promise<{ channel: string; ok: boolean; error?: string }>[] = [];
  const run = (channel: string, fn: () => Promise<void>) =>
    jobs.push(fn().then(() => ({ channel, ok: true }), (e) => ({ channel, ok: false, error: safeMessage(e) })));

  if (prefs.ntfyTopic) {
    run("ntfy", () =>
      post(`https://ntfy.sh/${prefs.ntfyTopic}`, {
        headers: { Title: ascii(n.title) || "DEX Scout", Click: appUrl(n.url), Priority: n.priority ?? "default", Tags: n.priority === "urgent" ? "rotating_light" : "moneybag" },
        body: n.body,
      }),
    );
  }
  if (prefs.discordWebhook) {
    run("discord", () =>
      post(prefs.discordWebhook!, {
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ content: `**${n.title}**\n${n.body}\n${appUrl(n.url)}`, allowed_mentions: { parse: [] } }),
      }),
    );
  }
  return Promise.all(jobs);
}

/** Record in-app and push to channels. Never throws: a notification problem must not break the trade flow that raised it. */
export async function notifyUser(userId: string, n: NotifyInput): Promise<void> {
  try {
    // a category the user switched off is neither shown in the bell nor pushed
    if ((await getNotificationPrefs(userId)).muted.includes(CATEGORY_OF[n.type])) return;
    const col = await collections.notifications();
    if (n.dedupeKey && (await col.findOne({ userId, dedupeKey: n.dedupeKey, createdAt: { $gt: new Date(Date.now() - (n.remindAfterMin ?? 60) * 60_000) } }, { projection: { _id: 1 } }))) return;
    const doc: NotificationDoc = { _id: newId(), userId, type: n.type, title: n.title, body: n.body, url: n.url, tradeId: n.tradeId ?? null, dedupeKey: n.dedupeKey ?? null, createdAt: new Date(), readAt: null };
    await col.insertOne(doc);
    const results = await pushToChannels(userId, n);
    for (const r of results.filter((x) => !x.ok)) {
      await logEvent({ type: "PROVIDER_ERROR", source: "notifications", userId, level: "WARN", message: `Notification via ${r.channel} failed: ${r.error}` });
    }
  } catch (err) {
    await logEvent({ type: "WORKER_ERROR", source: "notifications", userId, level: "WARN", message: `Could not send notification: ${safeMessage(err)}` }).catch(() => {});
  }
}

export async function listNotifications(userId: string, limit = 20) {
  const col = await collections.notifications();
  const [rows, unread] = await Promise.all([
    col.find({ userId }).sort({ createdAt: -1 }).limit(limit).toArray(),
    col.countDocuments({ userId, readAt: null }),
  ]);
  return { unread, items: withIds(rows) };
}

export async function markNotificationsRead(userId: string): Promise<void> {
  await (await collections.notifications()).updateMany({ userId, readAt: null }, { $set: { readAt: new Date() } });
}

/** Old notifications are only useful briefly; called from the retention job. */
export async function pruneNotifications(olderThanDays = 30): Promise<number> {
  const r = await (await collections.notifications()).deleteMany({ createdAt: { $lt: new Date(Date.now() - olderThanDays * 86_400_000) } });
  return r.deletedCount;
}

/**
 * If no scan has completed for a while the whole app quietly goes stale (prices, signals, the bot's entries). Tell users
 * who trade here (a linked wallet) so they hear it from us rather than by buying at an old price. Called from the monitor
 * job, which is a separate cron job from the scan, so it still runs when the scan job has died. Reminds every 3 hours.
 */
export async function checkScannerHealth(now = Date.now(), staleAfterMin = 20): Promise<{ stale: boolean; notified: number }> {
  const row = await (await collections.workerStates()).findOne({ _id: "scanner-worker" });
  // never ran at all (fresh install) is not "went offline"
  if (!row?.lastRunAt) return { stale: false, notified: 0 };
  const minutes = (now - row.lastRunAt.getTime()) / 60_000;
  if (minutes < staleAfterMin) return { stale: false, notified: 0 };
  const userIds = await (await collections.wallets()).distinct("userId");
  const msg = scannerOffline(minutes);
  await Promise.all(userIds.map((u) => notifyUser(u, msg)));
  return { stale: true, notified: userIds.length };
}
