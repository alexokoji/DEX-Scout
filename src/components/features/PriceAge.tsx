import { PRICE_MAX_AGE_MS, PRICE_WARN_AGE_MS } from "@/core/config";
import { age, ageMs } from "@/lib/format";
import { cn } from "@/lib/utils";

/** How old a displayed price is: quiet when fresh, amber when ageing, red when it can't be trusted. */
export function PriceAge({ at, className, label = "updated" }: { at: Date | string | null | undefined; className?: string; label?: string }) {
  const ms = ageMs(at);
  const text = at ? (age(at) === "now" ? "just now" : `${age(at)} ago`) : "never";
  return (
    <span
      className={cn("text-[10px]", ms > PRICE_MAX_AGE_MS ? "font-medium text-down" : ms > PRICE_WARN_AGE_MS ? "text-warn" : "text-muted", className)}
      title={ms > PRICE_MAX_AGE_MS ? "This price is old and may be far from the market. It is re-fetched before any trade." : "When this price was last fetched"}
    >
      {label} {text}
    </span>
  );
}
