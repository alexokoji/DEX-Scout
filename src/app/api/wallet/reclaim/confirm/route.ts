import { z } from "zod";
import { parseBody, protectedRoute, serialize } from "@/lib/api";
import { confirmReclaim } from "@/services/reclaim";

const body = z.object({ signature: z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{64,90}$/), wallet: z.string().min(20).max(64).optional() });

/** The wallet sent a close transaction: confirm it on-chain and record the refund against the position it came from. */
export const POST = protectedRoute(
  async ({ req, user }) => {
    const { signature, wallet } = await parseBody(req, body);
    return serialize(await confirmReclaim(user.id, signature, wallet));
  },
  { limit: { max: 20, windowMs: 60_000, key: "reclaim-confirm" } },
);
