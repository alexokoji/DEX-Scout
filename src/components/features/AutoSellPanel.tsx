"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badges";
import { Button } from "@/components/ui/button";
import { autoSellVenue, CHAINS } from "@/core/chains";
import type { ChainId } from "@/core/types";
import { price, usd } from "@/lib/format";
import { explainWalletError } from "@/lib/txErrors";
import { useSigner } from "./useSigner";

export interface AutoSellView {
  id: string;
  status: string;
  levels: number[];
  gainPct: number;
  targetPriceUsd: number;
  sellAmount: number;
  error: string | null;
}

const STATUS_TONE: Record<string, "green" | "blue" | "red" | "gray"> = { ACTIVE: "blue", FILLED: "green", FAILED: "red", EXPIRED: "red", CANCELLED: "gray", SUGGESTED: "gray" };

async function post<T>(action: string, body: object): Promise<T> {
  const r = await fetch(`/api/autosell/${action}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const j = await r.json();
  if (!r.ok) throw new Error(j.error ?? "Request failed");
  return j as T;
}

/**
 * Auto-sell for one open position. The bot prepares a limit sell per profit target when the position opens; arming them
 * takes one wallet approval, after which each sells on-chain by itself when its price is reached. Cancel any time.
 */
export function AutoSellPanel({ positionId, chain, orders }: { positionId: string; chain: string; orders: AutoSellView[] }) {
  const router = useRouter();
  const signer = useSigner();
  const [busy, setBusy] = useState(false);
  const venue = autoSellVenue(chain as ChainId);
  const active = orders.filter((o) => o.status === "ACTIVE");
  const shown = orders.filter((o) => o.status !== "CANCELLED" || active.length === 0).slice(-8);

  if (!venue) {
    return <div className="mt-3 rounded-md border border-border bg-surface2/40 px-3 py-2 text-[11px] text-muted">Auto-sell isn&apos;t available on {CHAINS[chain as ChainId]?.name ?? chain} yet. When a target is reached you&apos;ll be notified to sign the sell yourself.</div>;
  }

  async function run(fn: () => Promise<void>, ok: string) {
    if (!(await signer.ensureConnected(chain as ChainId))) return;
    setBusy(true);
    try {
      await fn();
      toast.success(ok);
    } catch (e) {
      console.error("[autosell] wallet error", e);
      toast.error(explainWalletError(e), { duration: 15_000 });
    } finally {
      setBusy(false);
      router.refresh();
    }
  }

  const arm = () =>
    run(async () => {
      if (venue !== "jupiter") {
        const p = await post<{ chainId: number; approval: { to: string; data: string; value?: string } | null; approvalFeeUsd: number | null; orders: { id: string; typedData: unknown }[] }>("prepare", { positionId, wallet: signer.addressFor(chain as ChainId) ?? undefined });
        // Say what the wallet is about to ask, before it asks: one approval transaction (the only thing that costs a network fee),
        // then one FREE signature per target. A signature popup shows the amount being sold, which reads like a fee but isn't one.
        const n = p.orders.length;
        const fee = p.approvalFeeUsd == null ? "a small network fee" : `a network fee of about ${usd(p.approvalFeeUsd, p.approvalFeeUsd < 0.1 ? 4 : 2)}`;
        const sigsWord = `${n} free signature${n === 1 ? "" : "s"}`;
        const stepToast = "autosell-steps";
        toast.message(p.approval ? `Your wallet will ask for 1 approval (${fee}), then ${sigsWord}, one per target. A signature costs nothing: it shows what would be sold, not a fee.` : `Your wallet will ask for ${sigsWord}, one per target. No approval is needed this time, and a signature costs nothing: it shows what would be sold, not a fee.`, { id: stepToast, duration: 20_000 });
        const sigs = await signer.signEvmOrders(p.chainId, p.approval, p.orders.map((o) => o.typedData), (s) => {
          const msg = s.kind === "approval" ? `Step ${s.step} of ${s.of}: approve the token in your wallet (${fee}). This is the only step that costs a network fee.`
            : s.kind === "confirming" ? "Approval sent. Waiting for the network to confirm it before the signatures…"
            : `Step ${s.step} of ${s.of}: sign order ${s.step - (p.approval ? 1 : 0)} of ${n}. Free, no network fee. It shows the amount that will be sold at the target price.`;
          toast.message(msg, { id: stepToast, duration: 120_000 });
        });
        toast.dismiss(stepToast);
        const res = await post<{ activated: string[]; failed: { id: string; error: string }[] }>("activate", { positionId, signatures: Object.fromEntries(p.orders.map((o, i) => [o.id, sigs[i]])) });
        if (res.failed.length) throw new Error(`${res.activated.length} order(s) placed, ${res.failed.length} failed: ${res.failed[0].error}`);
      } else {
        const p = await post<{ orders: { id: string }[] }>("prepare", { positionId, wallet: signer.addressFor(chain as ChainId) ?? undefined });
        for (const o of p.orders) {
          const tx = await post<{ unsignedTxBase64: string }>("prepare-order", { orderId: o.id });
          const signature = await signer.signAndSend("solana", tx.unsignedTxBase64);
          await post("activate-order", { orderId: o.id, signature });
        }
      }
    }, "Auto-sell armed: it will sell by itself when each target price is reached");

  const cancel = () =>
    run(async () => {
      if (venue !== "jupiter") {
        const p = await post<{ chainId: number; typedData: unknown }>("cancel-prepare", { positionId });
        const signature = await signer.signTyped(p.chainId, p.typedData);
        await post("cancel-confirm", { positionId, signature });
      } else {
        for (const o of active) {
          const tx = await post<{ unsignedTxBase64: string }>("cancel-prepare", { orderId: o.id });
          const signature = await signer.signAndSend("solana", tx.unsignedTxBase64);
          await post("cancel-confirm", { orderId: o.id, signature });
        }
      }
    }, "Auto-sell cancelled");

  return (
    <div className="mt-3 rounded-md border border-border bg-surface2/40 px-3 py-2.5 text-xs">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <div className="font-medium">Auto-sell {active.length ? <Badge tone="blue">armed</Badge> : <Badge>not armed</Badge>}</div>
          <div className="mt-0.5 text-[11px] text-muted">
            {active.length
              ? "These sell by themselves on-chain when the price is reached, even if you're away. To sell this position by hand first, cancel auto-sell."
              : "Nothing sells by itself yet. Arm it once and each profit target sells automatically when reached — you can cancel any time."}
          </div>
        </div>
        {active.length ? (
          <Button size="sm" variant="outline" disabled={busy} onClick={cancel}>{busy ? "Working…" : "Cancel auto-sell"}</Button>
        ) : (
          <Button size="sm" disabled={busy} onClick={arm}>{busy ? "Waiting for wallet…" : "Arm auto-sell"}</Button>
        )}
      </div>
      {shown.length > 0 && (
        <div className="mt-2 divide-y divide-border/60">
          {shown.map((o) => (
            <div key={o.id} className="flex flex-wrap items-center justify-between gap-2 py-1">
              <span>
                {o.levels.length > 1 ? `Targets ${o.levels.join("+")}` : `Target ${o.levels[0]}`} · +{o.gainPct}% · sell {o.sellAmount.toLocaleString(undefined, { maximumFractionDigits: 2 })} at ≥ {price(o.targetPriceUsd)}
              </span>
              <span className="flex items-center gap-2">
                {o.error && <span className="text-[10px] text-down" title={o.error}>{o.error.slice(0, 50)}</span>}
                <Badge tone={STATUS_TONE[o.status] ?? "gray"}>{o.status === "SUGGESTED" ? "suggested" : o.status.toLowerCase()}</Badge>
              </span>
            </div>
          ))}
        </div>
      )}
      {venue === "jupiter" && active.length === 0 && (
        <div className="mt-1.5 text-[11px] text-muted">
          Jupiter refuses limit orders below its own minimum size, so a small position can&apos;t be auto-sold on Solana. For those, reaching a target only queues a sell for you to sign (a notification), and it waits 10 minutes: nothing can sell it while you are away, because only your wallet can sign.
        </div>
      )}
      <div className="mt-1.5 text-[10px] text-muted">
        {venue === "cow" ? "Limit orders via CoW Protocol: one token approval for the exact amount (the only network fee you pay), then one free signature per target. Once armed, the orders fill by themselves, with nothing more to sign. They last 14 days; re-arm after that." : venue === "kyber" ? "Limit orders via KyberSwap: one token approval for the exact amount (the only network fee you pay), then one free signature per target. Once armed, the orders fill by themselves, with nothing more to sign. They last 14 days; re-arm after that. You receive the wrapped coin (e.g. WETH), which you can unwrap in your wallet." : "Limit orders via Jupiter: each order moves its tokens into Jupiter's escrow until it fills or you cancel. Jupiter keeps a small fee out of the proceeds; each fill shows exactly how much."}
      </div>
    </div>
  );
}
