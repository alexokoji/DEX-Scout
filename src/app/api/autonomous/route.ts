import { protectedRoute, serialize } from "@/lib/api";
import { collections } from "@/lib/db";
import { autonomousStatus } from "@/services/autonomous";
import { botWalletOverview } from "@/services/botWallet";
import { getSettings } from "@/services/settings";

/** Everything the unattended-trading page shows: the bot wallets and what they hold, the settings, and how today is going. */
export const GET = protectedRoute(
  async ({ user }) => {
    const settings = await getSettings(user.id);
    const [wallets, status] = await Promise.all([botWalletOverview(user.id), autonomousStatus(user.id, settings)]);
    // what the bot decided on its last check, token by token: why it bought or didn't
    const bot = await (await collections.bots()).findOne({ userId: user.id });
    const run = bot ? await (await collections.botRuns()).findOne({ botId: bot._id, finishedAt: { $ne: null } }, { sort: { startedAt: -1 } }) : null;
    const lastRun = run ? { at: run.startedAt, evaluated: run.signalsEvaluated, executed: run.tradesExecuted, reasons: run.summary ?? {} } : null;
    return serialize({ settings: settings.autonomous, wallets, status, lastRun });
  },
  { limit: { max: 60, windowMs: 60_000, key: "autonomous" } },
);
