import { protectedRoute, serialize } from "@/lib/api";
import { setBotState } from "../_shared";

/** Emergency stop: halts NEW trades only. Existing positions are not sold or altered. */
export const POST = protectedRoute(async ({ user }) => serialize(await setBotState(user.id, "DISABLED")));