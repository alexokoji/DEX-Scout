import { protectedRoute, serialize } from "@/lib/api";
import { listSignals } from "@/services/queries";

export const GET = protectedRoute(async ({ req }) => {
  const sp = new URL(req.url).searchParams;
  const num = (k: string) => (sp.get(k) ? Number(sp.get(k)) : undefined);
  return serialize(
    await listSignals({
      page: Math.max(1, num("page") ?? 1),
      pageSize: Math.min(200, Math.max(5, num("pageSize") ?? 25)),
      type: sp.get("type") ?? undefined,
      risk: sp.get("risk") ?? undefined,
      q: sp.get("q") ?? undefined,
      sort: sp.get("sort") ?? undefined,
      minScore: num("minScore"),
      minMcap: num("minMcap"),
      maxMcap: num("maxMcap"),
      dex: sp.get("dex") ?? undefined,
      activeOnly: sp.get("all") !== "true",
    }),
  );
});
