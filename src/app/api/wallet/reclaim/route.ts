import { z } from "zod";
import { parseBody, protectedRoute, serialize } from "@/lib/api";
import { buildReclaim, reclaimable } from "@/services/reclaim";

const q = z.object({ wallet: z.string().min(20).max(64).optional() });
const body = z.object({ wallet: z.string().min(20).max(64).optional() });

/** The wallet's empty Solana token accounts and the deposit each would return when closed. */
export const GET = protectedRoute(
  async ({ req, user }) => {
    const { wallet } = q.parse(Object.fromEntries(new URL(req.url).searchParams));
    return serialize(await reclaimable(user.id, wallet));
  },
  { limit: { max: 30, windowMs: 60_000, key: "reclaim-list" } },
);

/** Unsigned transactions that close those accounts, for the wallet to sign. Nothing is sent from here. */
export const POST = protectedRoute(
  async ({ req, user }) => {
    const { wallet } = await parseBody(req, body);
    return serialize(await buildReclaim(user.id, wallet));
  },
  { limit: { max: 10, windowMs: 60_000, key: "reclaim-build" } },
);
