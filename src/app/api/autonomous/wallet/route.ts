import { z } from "zod";
import { parseBody, protectedRoute, serialize } from "@/lib/api";
import { ensureBotWallet } from "@/services/botWallet";

const body = z.object({ family: z.enum(["solana", "evm"]) });

/** Create the bot wallet for an address family (once; asking again returns the same one). Returns only its public address. */
export const POST = protectedRoute(
  async ({ req, user }) => {
    const { family } = await parseBody(req, body);
    const w = await ensureBotWallet(user.id, family);
    return serialize({ family: w.family, address: w.address });
  },
  { limit: { max: 10, windowMs: 60_000, key: "botwallet-create" } },
);
