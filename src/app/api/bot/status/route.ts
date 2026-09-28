import { protectedRoute, serialize } from "@/lib/api";
import { botOverview } from "@/services/queries";

export const GET = protectedRoute(async ({ user }) => {
  const o = await botOverview(user.id);
  return serialize({ status: o.bot?.status ?? "PAUSED", environment: o.env, lastRunAt: o.bot?.lastRunAt ?? null, capital: o.pf.capital, realizedPnlUsd: o.pf.realizedPnlUsd, unrealizedPnlUsd: o.pf.unrealizedPnlUsd, tradesToday: o.tradesToday, totals: o.totals });
});