import { protectedRoute } from "@/lib/api";
import { pushToChannels } from "@/services/notifications";

/** Sends a test message to the user's saved ntfy/Discord channels and reports which worked. Not recorded in the bell. */
export const POST = protectedRoute(
  async ({ user }) => {
    const results = await pushToChannels(user.id, {
      type: "SELL_QUEUED",
      title: "DEX Scout test",
      body: "If you can read this, you will be alerted when a trade is waiting for your signature, a trade confirms or fails, or a position is in trouble.",
      url: "/wallet",
    });
    return { results };
  },
  { limit: { max: 6, windowMs: 60_000, key: "notify-test" } },
);
