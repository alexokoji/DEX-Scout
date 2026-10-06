import { z } from "zod";
import { parseBody, protectedRoute, serialize } from "@/lib/api";
import { setPositionTargets, targetsInput } from "@/services/positionTargets";

const body = z.object({ targets: targetsInput });

/** Set the profit targets for this one position (its own ladder, independent of the default in Settings and of every other position). */
export const POST = protectedRoute<{ id: string }>(
  async ({ req, user, params }) => {
    const { targets } = await parseBody(req, body);
    return serialize(await setPositionTargets(user.id, params.id, targets));
  },
  { limit: { max: 30, windowMs: 60_000, key: "position-targets" } },
);
