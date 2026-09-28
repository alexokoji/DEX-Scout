import { parseBody, protectedRoute, serialize } from "@/lib/api";
import { getSettings, tradingSettingsInput, updateSettings } from "@/services/settings";
import { ApiError } from "@/lib/api";
import { liveTradingAllowed } from "@/lib/env";

export const GET = protectedRoute(async ({ user }) => serialize(await getSettings(user.id)));

export const PUT = protectedRoute(async ({ req, user }) => {
  const input = await parseBody(req, tradingSettingsInput);
  if (input.environment === "LIVE" && !liveTradingAllowed()) {
    throw new ApiError("LIVE environment cannot be selected: live trading is disabled by server configuration", 403);
  }
  return serialize(await updateSettings(user.id, input));
});