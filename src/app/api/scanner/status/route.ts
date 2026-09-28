import { protectedRoute, serialize } from "@/lib/api";
import { db } from "@/lib/db";
import { env } from "@/lib/env";
import { workerStatuses } from "@/services/workerState";

export const GET = protectedRoute(async () => {
  const [workers, tokens, passing, activeSignals] = await Promise.all([
    workerStatuses(),
    db.token.count(),
    db.token.count({ where: { passedFilters: true } }),
    db.signal.count({ where: { status: "ACTIVE" } }),
  ]);
  return serialize({ workers, tokens, passing, activeSignals, provider: env().MOCK_PROVIDER ? "MOCK" : "LIVE" });
});