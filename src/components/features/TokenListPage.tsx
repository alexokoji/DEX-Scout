import Link from "next/link";
import { Suspense } from "react";
import { Card } from "@/components/ui/card";
import { collections } from "@/lib/db";
import { cn } from "@/lib/utils";
import { listTokens, tokenQuerySchema } from "@/services/queries";
import { FilterBar } from "./FilterBar";
import { LiveRefresh } from "./LiveRefresh";
import { Pagination } from "./Pagination";
import { PageHeader } from "./PageHeader";
import { TokenTable } from "./TokenTable";

type SP = Record<string, string | string[] | undefined>;

export async function TokenListPage({ searchParams, basePath, title, subtitle, defaults }: { searchParams: SP; basePath: string; title: string; subtitle: string; defaults: { passing?: "true" | "false"; signal?: "ANY"; sort?: string; showStage?: boolean; trust?: "VERIFIED" | "TRUSTED" | "UNPROVEN" | "ALL" } }) {
  const flat = Object.fromEntries(Object.entries(searchParams).map(([k, v]) => [k, Array.isArray(v) ? v[0] : v]));
  const parsed = tokenQuerySchema.safeParse({
    passing: defaults.passing,
    signal: defaults.signal,
    sort: defaults.sort,
    trust: defaults.trust,
    ...flat,
  });
  const query = parsed.success ? parsed.data : tokenQuerySchema.parse({});
  const tokensCol = await collections.tokens();
  const [result, dexes] = await Promise.all([listTokens(query), tokensCol.distinct("dex")]);
  dexes.sort();
  const params: Record<string, string | undefined> = Object.fromEntries(Object.entries(flat).filter(([k]) => k !== "page"));
  const staleLink = (p: Record<string, string | undefined>, on: boolean) => {
    const sp = new URLSearchParams(Object.entries(p).filter(([k, v]) => v && k !== "stale") as [string, string][]);
    if (on) sp.set("stale", "true");
    return sp.toString();
  };
  const trustLink = (tier: string) => {
    const sp = new URLSearchParams(Object.entries(params).filter(([k, v]) => v && k !== "trust") as [string, string][]);
    sp.set("trust", tier);
    return sp.toString();
  };
  const tab = (label: string, passing: string) => {
    const sp = new URLSearchParams(Object.entries(params).filter(([, v]) => v) as [string, string][]);
    sp.set("passing", passing);
    sp.delete("page");
    return (
      <Link href={`${basePath}?${sp.toString()}`} className={cn("rounded px-2.5 py-1 text-xs", (query.passing ?? "false") === passing ? "bg-surface2 text-foreground" : "text-muted hover:text-foreground")}>
        {label}
      </Link>
    );
  };

  return (
    <div className="space-y-4">
      <PageHeader title={title} subtitle={subtitle} right={<LiveRefresh seconds={15} />} />
      <Card className="p-3">
        <Suspense>
          <FilterBar dexes={dexes} showSignal defaultTrust={defaults.trust ?? "ALL"} />
        </Suspense>
      </Card>
      <Card>
        {defaults.showStage && (
          <div className="flex items-center gap-1 border-b border-border px-3 py-2">
            {tab("All discovered", "false")}
            {tab("Passing filters", "true")}
          </div>
        )}
        {query.trust && query.trust !== "ALL" ? (
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border bg-surface2/40 px-3 py-2 text-xs text-muted">
            <span>
              Showing {query.trust === "VERIFIED" ? "verified" : query.trust === "TRUSTED" ? "trusted and verified" : "proven-safe-so-far"} tokens only: ones independent checks cleared, with real liquidity and history.
              {result.untrustedHidden > 0 && ` ${result.untrustedHidden} more haven't earned trust yet (too new, too thin, or with red flags) and are hidden.`}
            </span>
            <Link href={`${basePath}?${trustLink("ALL")}`} className="text-accent">Show everything</Link>
          </div>
        ) : defaults.trust && defaults.trust !== "ALL" ? (
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border bg-warn/10 px-3 py-2 text-xs text-warn">
            <span>Showing every token, including ones that haven&apos;t earned trust. Many new tokens are scams: look at the Trust column before anything else.</span>
            <Link href={`${basePath}?${trustLink(defaults.trust)}`} className="text-accent">Trusted only</Link>
          </div>
        ) : null}
        {(result.staleHidden > 0 || query.stale === "true") && (
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border bg-surface2/40 px-3 py-2 text-xs text-muted">
            {query.stale === "true" ? (
              <span className="text-warn">Showing tokens with old prices too. Their prices are not live — open a token to refresh it.</span>
            ) : (
              <span>{result.staleHidden} token(s) hidden: their price hasn&apos;t been refreshed in the last 30 minutes, so it isn&apos;t shown as current.</span>
            )}
            <Link href={`${basePath}?${staleLink(params, query.stale !== "true")}`} className="text-accent">{query.stale === "true" ? "Hide them" : "Show them"}</Link>
          </div>
        )}
        <TokenTable rows={result.rows} showStage={defaults.showStage} />
        <Pagination page={query.page} pages={result.pages} total={result.total} basePath={basePath} params={params} />
      </Card>
    </div>
  );
}
