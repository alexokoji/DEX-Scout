import { z } from "zod";
import { CHAIN_IDS } from "@/core/chains";
import { parseBody, protectedRoute, serialize } from "@/lib/api";
import { withdrawNative } from "@/services/botWallet";

const body = z.object({ chain: z.enum(CHAIN_IDS), to: z.string().min(20).max(64).optional() });

/** Send the bot wallet's balance of a chain's own coin to the user's own verified wallet. It can't be sent anywhere else. */
export const POST = protectedRoute(
  async ({ req, user }) => {
    const { chain, to } = await parseBody(req, body);
    return serialize(await withdrawNative(user.id, chain, to));
  },
  { limit: { max: 10, windowMs: 60_000, key: "botwallet-withdraw" } },
);
