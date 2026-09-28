"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useTransition } from "react";
import { Button } from "@/components/ui/button";
import { Input, Select } from "@/components/ui/form";
import { CHAIN_IDS, CHAINS } from "@/core/chains";

const SORTS = [
  ["opportunityScore", "Score"],
  ["marketCapUsd", "Market cap"],
  ["liquidityUsd", "Liquidity"],
  ["volume24hUsd", "24h volume"],
  ["change5m", "5m change"],
  ["change1h", "1h change"],
  ["buySellRatio", "Buy/sell"],
  ["holderGrowth1h", "Holder growth"],
  ["poolCreatedAt", "Newest"],
  ["updatedAt", "Updated"],
];

export function FilterBar({ dexes, showSignal = true }: { dexes: string[]; showSignal?: boolean }) {
  const router = useRouter();
  const path = usePathname();
  const sp = useSearchParams();
  const [pending, start] = useTransition();

  function apply(form: HTMLFormElement) {
    const f = new FormData(form);
    const next = new URLSearchParams();
    for (const [k, v] of f.entries()) if (typeof v === "string" && v.trim() !== "") next.set(k, v.trim());
    // market-cap inputs are in $M for convenience
    for (const k of ["minMcap", "maxMcap"]) if (next.has(k)) next.set(k, String(Number(next.get(k)) * 1_000_000));
    for (const k of ["minLiq"]) if (next.has(k)) next.set(k, String(Number(next.get(k)) * 1_000));
    next.delete("page");
    start(() => router.push(`${path}?${next.toString()}`));
  }
  const m = (k: string) => (sp.get(k) ? String(Number(sp.get(k)) / 1_000_000) : "");
  const k = (key: string) => (sp.get(key) ? String(Number(sp.get(key)) / 1_000) : "");

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        apply(e.currentTarget);
      }}
      className="grid grid-cols-2 gap-2 sm:grid-cols-3 xl:grid-cols-6"
    >
      <Input name="q" placeholder="Search symbol / name" defaultValue={sp.get("q") ?? ""} className="col-span-2" />
      <Input name="minMcap" type="number" step="any" min="0" placeholder="Min mcap $M" defaultValue={m("minMcap")} />
      <Input name="maxMcap" type="number" step="any" min="0" placeholder="Max mcap $M" defaultValue={m("maxMcap")} />
      <Input name="minLiq" type="number" step="any" min="0" placeholder="Min liq $K" defaultValue={k("minLiq")} />
      <Select name="risk" defaultValue={sp.get("risk") ?? ""}>
        <option value="">Any risk</option>
        <option value="LOWER">Lower</option>
        <option value="LOWER,MODERATE">Lower + moderate</option>
        <option value="HIGH,CRITICAL">High + critical</option>
      </Select>
      {showSignal && (
        <Select name="signal" defaultValue={sp.get("signal") ?? ""}>
          <option value="">Any signal</option>
          <option value="BUY">BUY</option>
          <option value="WATCH">WATCH</option>
          <option value="ANY">BUY + WATCH</option>
          <option value="NONE">No signal</option>
        </Select>
      )}
      <Select name="dex" defaultValue={sp.get("dex") ?? ""}>
        <option value="">Any DEX</option>
        {dexes.map((d) => (
          <option key={d} value={d}>{d}</option>
        ))}
      </Select>
      <Select name="sort" defaultValue={sp.get("sort") ?? "opportunityScore"}>
        {SORTS.map(([v, l]) => (
          <option key={v} value={v}>Sort: {l}</option>
        ))}
      </Select>
      <Select name="dir" defaultValue={sp.get("dir") ?? "desc"}>
        <option value="desc">Descending</option>
        <option value="asc">Ascending</option>
      </Select>
      <Select name="chain" defaultValue={sp.get("chain") ?? ""}>
        <option value="">All chains</option>
        {CHAIN_IDS.map((c) => (
          <option key={c} value={c}>{CHAINS[c].name}</option>
        ))}
      </Select>
      <Select name="pageSize" defaultValue={sp.get("pageSize") ?? "25"}>
        {[25, 50, 100].map((n) => (
          <option key={n} value={n}>{n} / page</option>
        ))}
      </Select>
      <Button type="submit" disabled={pending}>{pending ? "Applying…" : "Apply"}</Button>
      <Button type="button" variant="outline" onClick={() => router.push(path)}>Reset</Button>
    </form>
  );
}
