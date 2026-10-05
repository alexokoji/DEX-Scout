import { z } from "zod";
import { ApiError, parseBody, protectedRoute, serialize } from "@/lib/api";
import { collections } from "@/lib/db";
import * as autoSell from "@/services/autoSell";

/**
 * Auto-sell endpoints. Everything here only PREPARES what the user's wallet signs, or submits what it signed; no route
 * signs anything. Orders are rebuilt server-side from stored data: the browser sends ids and signatures, never amounts.
 */
const wallet = z.string().min(20).max(64).optional();
const position = z.object({ positionId: z.string().min(1), wallet });
const order = z.object({ orderId: z.string().min(1) });
const evmSignatures = position.extend({ signatures: z.record(z.string(), z.string()) });
const solSignature = order.extend({ signature: z.string().min(1) });
const cancelEvm = position.extend({ signature: z.string().min(1) });

async function chainOf(positionId: string, userId: string): Promise<string> {
  const pos = await (await collections.positions()).findOne({ _id: positionId, userId });
  const token = pos ? await (await collections.tokens()).findOne({ _id: pos.tokenId }, { projection: { chain: 1 } }) : null;
  if (!token) throw new ApiError("Position not found", 404);
  return token.chain;
}

export const POST = protectedRoute<{ action: string }>(
  async ({ req, user, params }) => {
    switch (params.action) {
      case "prepare": {
        const { positionId, wallet } = await parseBody(req, position);
        return serialize((await chainOf(positionId, user.id)) === "solana" ? await autoSell.prepareArmSolanaPlan(user.id, positionId, wallet) : await autoSell.prepareArmEvm(user.id, positionId, wallet));
      }
      case "prepare-order": // Solana: a fresh transaction per order, so none goes stale while the user signs the others
        return serialize(await autoSell.prepareSolanaOrder(user.id, (await parseBody(req, order)).orderId));
      case "activate": {
        const b = await parseBody(req, evmSignatures);
        return serialize(await autoSell.activateEvm(user.id, b.positionId, b.signatures));
      }
      case "activate-order": {
        const b = await parseBody(req, solSignature);
        return serialize(await autoSell.activateSolana(user.id, b.orderId, b.signature));
      }
      case "cancel-prepare": {
        const b = await parseBody(req, z.object({ positionId: z.string().optional(), orderId: z.string().optional() }));
        if (b.orderId) return serialize(await autoSell.prepareCancelSolana(user.id, b.orderId));
        if (b.positionId) return serialize(await autoSell.prepareCancelEvm(user.id, b.positionId));
        throw new ApiError("positionId or orderId required", 400);
      }
      case "cancel-confirm": {
        const b = await parseBody(req, z.object({ positionId: z.string().optional(), orderId: z.string().optional(), signature: z.string().min(1) }));
        if (b.orderId) return serialize(await autoSell.confirmCancelSolana(user.id, b.orderId, b.signature));
        if (b.positionId) return serialize(await autoSell.confirmCancelEvm(user.id, b.positionId, cancelEvm.parse({ positionId: b.positionId, signature: b.signature }).signature));
        throw new ApiError("positionId or orderId required", 400);
      }
      default:
        throw new ApiError("Unknown action", 404);
    }
  },
  { limit: { max: 40, windowMs: 60_000, key: "autosell" } },
);
