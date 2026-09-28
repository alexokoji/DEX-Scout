import { ApiError, protectedRoute, serialize } from "@/lib/api";
import { getTokenDetail } from "@/services/queries";

export const GET = protectedRoute<{ address: string }>(async ({ req, params }) => {
  const chain = new URL(req.url).searchParams.get("chain") ?? undefined;
  const detail = await getTokenDetail(params.address, chain);
  if (!detail) throw new ApiError("Token not found", 404);
  const { token, signal } = detail;
  const { analysis, ...rest } = token;
  return serialize({
    ...rest,
    analysis: analysis ? { opportunityScore: analysis.opportunityScore, components: analysis.components, market: analysis.market, onchain: analysis.onchain, computedAt: analysis.computedAt } : null,
    signals: signal ? [signal] : [],
  });
});
