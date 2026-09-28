import { protectedRoute, serialize } from "@/lib/api";
import { setBotState } from "../_shared";

export const POST = protectedRoute(async ({ user }) => serialize(await setBotState(user.id, "ACTIVE")));