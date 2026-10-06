import { z } from "zod";
import type { ChainId } from "@/core/types";
import { ApiError, protectedRoute, serialize } from "@/lib/api";
import { projectionFor } from "@/services/projection";
import { findToken } from "@/services/queries";

const q = z.object({ chain: z.string().optional() });

/** The token's projected rises from its own price history: what it has done, as a base rate to set targets against (not a forecast). */
export const GET = protectedRoute<{ address: string }>(async ({ req, params }) => {
  const { chain } = q.parse(Object.fromEntries(new URL(req.url).searchParams));
  const token = await findToken(params.address, chain);
  if (!token) throw new ApiError("Token not found", 404);
  return serialize({ projection: await projectionFor(token.chain as ChainId, token.address) });
});
