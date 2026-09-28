import { ApiError, protectedRoute, serialize } from "@/lib/api";
import { findToken } from "@/services/queries";

export const GET = protectedRoute<{ address: string }>(async ({ req, params }) => {
  const chain = new URL(req.url).searchParams.get("chain") ?? undefined;
  const token = await findToken(params.address, chain, {
    safety: true,
    analysis: true,
    signals: { where: { status: "ACTIVE" }, orderBy: { createdAt: "desc" }, take: 1, include: { analysis: true } },
  });
  if (!token) throw new ApiError("Token not found", 404);
  const { analysis, ...rest } = token as typeof token & { analysis: { opportunityScore: number; components: unknown; market: unknown; onchain: unknown; computedAt: Date } | null };
  return serialize({ ...rest, analysis: analysis ? { opportunityScore: analysis.opportunityScore, components: analysis.components, market: analysis.market, onchain: analysis.onchain, computedAt: analysis.computedAt } : null });
});
