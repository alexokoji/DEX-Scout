import { protectedRoute, serialize } from "@/lib/api";
import { collections } from "@/lib/db";
import { env } from "@/lib/env";
import { workerStatuses } from "@/services/workerState";

export const GET = protectedRoute(async () => {
  const [tokensCol, signalsCol] = await Promise.all([collections.tokens(), collections.signals()]);
  const [workers, tokens, passing, activeSignals] = await Promise.all([
    workerStatuses(),
    tokensCol.countDocuments({}),
    tokensCol.countDocuments({ passedFilters: true }),
    signalsCol.countDocuments({ status: "ACTIVE" }),
  ]);
  return serialize({ workers, tokens, passing, activeSignals, provider: env().MOCK_PROVIDER ? "MOCK" : "LIVE" });
});
