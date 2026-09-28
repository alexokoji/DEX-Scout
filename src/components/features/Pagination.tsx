import Link from "next/link";

export function Pagination({ page, pages, total, basePath, params }: { page: number; pages: number; total: number; basePath: string; params: Record<string, string | undefined> }) {
  const href = (p: number) => {
    const sp = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) if (v) sp.set(k, v);
    sp.set("page", String(p));
    return `${basePath}?${sp.toString()}`;
  };
  return (
    <div className="flex items-center justify-between px-4 py-3 text-xs text-muted">
      <span>{total.toLocaleString()} results</span>
      <div className="flex items-center gap-2">
        {page > 1 ? <Link className="rounded border border-border px-2 py-1 hover:bg-surface2" href={href(page - 1)}>Prev</Link> : <span className="px-2 py-1 opacity-40">Prev</span>}
        <span className="num">{page} / {pages}</span>
        {page < pages ? <Link className="rounded border border-border px-2 py-1 hover:bg-surface2" href={href(page + 1)}>Next</Link> : <span className="px-2 py-1 opacity-40">Next</span>}
      </div>
    </div>
  );
}
