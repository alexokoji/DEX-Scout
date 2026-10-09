import { protectedRoute, serialize } from "@/lib/api";
import { collections, withIds } from "@/lib/db";
import { botAddresses } from "@/services/autonomous";
import { attachTokens } from "@/services/queries";

/** LIVE trades (manual or bot-created) waiting for the user's wallet signature, with their unsigned transactions. */
export const GET = protectedRoute(async ({ user }) => {
  const trades = await collections.trades();
  // trades in the bot wallet are signed by the server, never by the user's own wallet: they don't belong in this queue
  const bot = await botAddresses(user.id);
  const raw = withIds(
    await trades
      .find({ userId: user.id, environment: "LIVE", status: "PREPARED", expiresAt: { $gt: new Date() }, ...(bot.length ? { "quote.wallet": { $nin: bot } } : {}) })
      .sort({ createdAt: -1 })
      .toArray(),
  );
  const withToken = await attachTokens(raw);
  return serialize(
    withToken.map(({ quote, transaction, token, ...t }) => ({
      ...t,
      token: { symbol: token.symbol, address: token.address, chain: token.chain },
      unsignedTxBase64: transaction?.unsignedTx ?? null,
      reason: (quote as { reason?: string } | null)?.reason ?? null,
    })),
  );
});
