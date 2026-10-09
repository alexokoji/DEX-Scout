import { protectedRoute, serialize } from "@/lib/api";
import { autonomousStatus } from "@/services/autonomous";
import { botWalletOverview } from "@/services/botWallet";
import { getSettings } from "@/services/settings";

/** Everything the unattended-trading page shows: the bot wallets and what they hold, the settings, and how today is going. */
export const GET = protectedRoute(
  async ({ user }) => {
    const settings = await getSettings(user.id);
    const [wallets, status] = await Promise.all([botWalletOverview(user.id), autonomousStatus(user.id, settings)]);
    return serialize({ settings: settings.autonomous, wallets, status });
  },
  { limit: { max: 60, windowMs: 60_000, key: "autonomous" } },
);
