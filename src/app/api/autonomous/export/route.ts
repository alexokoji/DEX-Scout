import { z } from "zod";
import { parseBody, protectedRoute, serialize } from "@/lib/api";
import { exportBotKey } from "@/services/botWallet";

const body = z.object({ family: z.enum(["solana", "evm"]), password: z.string().min(1).max(200) });

/** The bot wallet's key, so the money never depends on this app. Needs the account password, and is rate-limited hard. */
export const POST = protectedRoute(
  async ({ req, user }) => {
    const { family, password } = await parseBody(req, body);
    return serialize(await exportBotKey(user.id, family, password));
  },
  { limit: { max: 5, windowMs: 10 * 60_000, key: "botwallet-export" } },
);
