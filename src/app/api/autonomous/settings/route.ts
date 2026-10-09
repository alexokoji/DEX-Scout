import { parseBody, protectedRoute, serialize } from "@/lib/api";
import { setAutonomous } from "@/services/autonomous";
import { autonomousInput } from "@/services/settings";

/** Save the daily target and its limits, and switch unattended trading on or off. */
export const POST = protectedRoute(
  async ({ req, user }) => {
    const input = await parseBody(req, autonomousInput);
    return serialize((await setAutonomous(user.id, input)).autonomous);
  },
  { limit: { max: 20, windowMs: 60_000, key: "autonomous-settings" } },
);
