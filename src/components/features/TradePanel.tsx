"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { Badge, TrustBadge } from "@/components/ui/badges";
import { Button } from "@/components/ui/button";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { Dialog, DialogContent, Input, Label } from "@/components/ui/form";
import { CHAINS } from "@/core/chains";
import type { ChainId } from "@/core/types";
import { price, usd, usdBalance } from "@/lib/format";
import { explainWalletError } from "@/lib/txErrors";
import { useMarketPrice } from "./LivePrice";
import { useSigner } from "./useSigner";

interface Quote {
  effectivePriceUsd: number;
  outputAmount: number;
  minReceived: number;
  priceImpactPct: number;
  networkFeeUsd: number;
  priorityFeeUsd: number;
  platformFeeUsd: number;
  route: string[];
  slippageBps: number;
  source: string;
}
interface QuoteResp {
  quote: Quote;
  /** the wallet the server checked, with what it holds on this chain */
  wallet?: { address: string; balanceUsd: number | null; spendableUsd: number | null; reserveUsd: number | null } | null;
  /** what suits how fast the token is moving right now, never above the user's own maximum */
  slippage?: { bps: number; wantedBps: number; cappedByMax: boolean; movePct: number };
  /** how far the token has earned trust, and why */
  trust?: { tier: string; summary: string };
  violations: string[];
  warnings?: string[];
  analysis: { riskLevel: string; warnings: string[]; criticalIssues: string[] };
  source: string;
}

export function TradePanel({ chain, address, symbol, signalId, defaults, liveEnabled }: { chain: ChainId; address: string; symbol: string; signalId?: string; defaults: { amountUsd: number; slippageBps: number; maxPositionUsd: number }; liveEnabled: boolean }) {
  const router = useRouter();
  const signer = useSigner();
  const meta = CHAINS[chain];
  const [amount, setAmount] = useState(String(defaults.amountUsd));
  const [slippagePct, setSlippagePct] = useState(String(defaults.slippageBps / 100));
  const market = useMarketPrice(chain, address);
  // blank = automatic. On Solana the app reads the network's current priority fee itself; a number here is only a CAP on it.
  const [priority, setPriority] = useState("");
  const [q, setQ] = useState<QuoteResp | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [needsVerify, setNeedsVerify] = useState(false);
  const [trustAck, setTrustAck] = useState(false);
  const wallet = signer.addressFor(chain);

  const body = useMemo(() => {
    const amountUsd = Number(amount);
    const slippageBps = Math.round(Number(slippagePct) * 100);
    if (!(amountUsd > 0) || !(slippageBps > 0)) return null;
    return { chain, tokenAddress: address, amountUsd, slippageBps, priorityFeeNative: Number(priority) || 0, environment: "LIVE" as const, signalId, wallet: wallet ?? undefined };
  }, [amount, slippagePct, priority, address, signalId, chain, wallet]);

  useEffect(() => {
    if (!body) return;
    let cancelled = false;
    const t = setTimeout(async () => {
      setLoading(true);
      try {
        const r = await fetch("/api/trades/quote", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
        const j = await r.json();
        if (cancelled) return;
        if (!r.ok) {
          setErr(j.error ?? "Quote failed");
          setNeedsVerify(!!j.hint?.verify);
          setQ(null);
        } else {
          setQ(j);
          setErr(null);
          setNeedsVerify(false);
        }
      } catch {
        if (!cancelled) setErr("Network error while fetching quote");
      } finally {
        if (!cancelled) setLoading(false);
      }
    }, 400);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [body]);

  async function confirm() {
    if (!body) return;
    setBusy(true);
    try {
      if (!(await signer.ensureConnected(chain))) return;
      const prep = await fetch("/api/trades/prepare", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...body, acknowledgeTrust: trustAck }) });
      const pj = await prep.json();
      if (!prep.ok) {
        // the server dry-runs the swap before the wallet opens; if only a looser slippage would work it says which, so apply it
        if (pj.hint?.slippageBps) setSlippagePct(String(pj.hint.slippageBps / 100));
        toast.error(pj.violations?.[0] ?? pj.error ?? "Trade rejected", { duration: 15_000 });
        return;
      }
      // The wallet shows the transaction and asks the user to approve. We never see keys.
      const signature = await signer.signAndSend(chain, pj.unsignedTxBase64);
      const ex = await fetch("/api/trades/execute", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ tradeId: pj.tradeId, signature }) });
      const ej = await ex.json();
      if (!ex.ok) {
        toast.error(ej.error ?? "Execution failed");
      } else if (ej.ok === false && ej.reason) {
        toast.error(`Live trade failed: ${ej.reason}`);
      } else {
        toast.success("Transaction submitted — awaiting confirmation");
        setOpen(false);
        router.refresh();
      }
    } catch (e) {
      console.error("[trade] wallet error", e);
      toast.error(explainWalletError(e), { duration: 15_000 });
    } finally {
      setBusy(false);
    }
  }

  const needsAck = q?.trust?.tier === "UNPROVEN" || q?.trust?.tier === "RISKY";
  const blocked = !liveEnabled || !body || !q || q.violations.length > 0 || loading || (needsAck && !trustAck);
  return (
    <Card>
      <CardHeader title={`Trade · ${meta.name}`} right={<Badge tone="red">LIVE — real funds</Badge>} />
      <CardBody className="space-y-3">
        {!liveEnabled && <p className="rounded-md border border-warn/30 bg-warn/10 p-2 text-xs text-warn">LIVE trading is disabled by server configuration.</p>}
        <div className="grid grid-cols-2 gap-2">
          <div>
            <Label hint="USD">Amount</Label>
            <Input type="number" min="0" step="any" value={amount} onChange={(e) => setAmount(e.target.value)} />
          </div>
          <div>
            <Label hint="%">Slippage</Label>
            <Input type="number" min="0" step="0.1" value={slippagePct} onChange={(e) => setSlippagePct(e.target.value)} />
          </div>
        </div>
        {q?.slippage && (q.slippage.bps > Math.round(Number(slippagePct) * 100) || q.slippage.cappedByMax) && (
          <p className="rounded-md border border-warn/30 bg-warn/10 p-2 text-xs text-warn">
            This token has moved about {q.slippage.movePct.toFixed(0)}% recently, so the price can shift before your swap lands and the chain cancels it (you would lose only the network fee).{" "}
            {q.slippage.bps > Math.round(Number(slippagePct) * 100) && (
              <button type="button" className="font-medium underline" onClick={() => setSlippagePct(String(q.slippage!.bps / 100))}>Use {q.slippage.bps / 100}% slippage</button>
            )}
            {q.slippage.cappedByMax && <span> Your maximum slippage in Settings ({q.slippage.bps / 100}%) is lower than the {q.slippage.wantedBps / 100}% this token calls for.</span>}
          </p>
        )}
        <div>
          <Label hint={`${meta.nativeSymbol} · blank = automatic, from the network`}>{meta.family === "evm" ? "Priority fee (gas tip)" : "Max priority fee"}</Label>
          <Input type="number" min="0" step="0.00001" placeholder="automatic" value={priority} onChange={(e) => setPriority(e.target.value)} />
        </div>

        <div className="rounded-md border border-border bg-surface2 p-3 text-xs">
          {err ? (
            <div className="space-y-1.5">
              <div className="text-down">{err}</div>
              {needsVerify && <Link href="/wallet" className="inline-block rounded border border-border px-2 py-1 text-accent hover:bg-surface">Open Wallet → Verify &amp; link</Link>}
            </div>
          ) : !q ? (
            <div className="text-muted">{loading ? "Fetching quote…" : "Enter an amount to see a quote"}</div>
          ) : (
            <dl className="space-y-1">
              {q.wallet ? (
                <Row k="Trading wallet" v={`${q.wallet.address.slice(0, 6)}…${q.wallet.address.slice(-4)} · ${q.wallet.balanceUsd !== null ? `${usdBalance(q.wallet.balanceUsd)} ${meta.nativeSymbol}` : "balance unavailable"}`} warn={q.wallet.balanceUsd !== null && q.wallet.balanceUsd < 0.01} />
              ) : (
                <Row k="Trading wallet" v="none linked yet" warn />
              )}
              <Row k="Route" v={q.quote.route.join(" → ")} />
              <Row k="Est. output" v={`${q.quote.outputAmount.toLocaleString(undefined, { maximumFractionDigits: 2 })} ${symbol}`} />
              <Row k="Min received" v={`${q.quote.minReceived.toLocaleString(undefined, { maximumFractionDigits: 2 })} ${symbol}`} />
              {market && <Row k="Market price (live)" v={price(market.priceUsd)} />}
              <Row k="Effective price (what you pay per token)" v={price(q.quote.effectivePriceUsd)} />
              {market && market.priceUsd > 0 && <Row k="You pay vs market" v={`${((q.quote.effectivePriceUsd / market.priceUsd - 1) * 100).toFixed(2)}% (price impact + fees + spread)`} warn={q.quote.effectivePriceUsd / market.priceUsd - 1 > 0.03} />}
              <Row k="Price impact" v={`${q.quote.priceImpactPct.toFixed(2)}%`} warn={q.quote.priceImpactPct > 2} />
              <Row k="Network + priority fee" v={usd(q.quote.networkFeeUsd + q.quote.priorityFeeUsd, 4)} />
              <Row k="Swap fee" v={usd(q.quote.platformFeeUsd, 3)} />
            </dl>
          )}
        </div>

        {q?.trust && (
          <div className={`space-y-2 rounded-md border p-3 text-xs ${q.trust.tier === "DANGEROUS" || q.trust.tier === "RISKY" ? "border-down/30 bg-down/10 text-down" : q.trust.tier === "UNPROVEN" ? "border-warn/30 bg-warn/10 text-warn" : "border-up/30 bg-up/10 text-up"}`}>
            <div className="flex items-center gap-2"><TrustBadge tier={q.trust.tier} /><span className="font-medium">{q.trust.tier === "VERIFIED" || q.trust.tier === "TRUSTED" ? "This token passed independent checks" : "This token has not earned trust"}</span></div>
            <p>{q.trust.summary}</p>
            {needsAck && (
              <label className="flex cursor-pointer items-start gap-2 text-foreground">
                <input type="checkbox" className="mt-0.5" checked={trustAck} onChange={(e) => setTrustAck(e.target.checked)} />
                <span>I understand this token is {q.trust.tier === "RISKY" ? "risky" : "unverified"} and I could lose everything I put in.</span>
              </label>
            )}
          </div>
        )}

        {q && q.violations.length === 0 && (q.warnings?.length ?? 0) > 0 && (
          <ul className="space-y-1 rounded-md border border-warn/30 bg-warn/10 p-3 text-xs text-warn">
            {q.warnings!.map((w) => (
              <li key={w}>• {w} — you can still buy; this is your own preference, not a safety block.</li>
            ))}
          </ul>
        )}

        {q && q.violations.length > 0 && (
          <ul className="space-y-1 rounded-md border border-down/30 bg-down/10 p-3 text-xs text-down">
            {q.violations.map((v) => (
              <li key={v}>• {v}</li>
            ))}
          </ul>
        )}

        <Button variant="buy" size="lg" className="w-full" disabled={blocked} onClick={() => setOpen(true)}>
          BUY {symbol}
        </Button>
        <p className="text-[11px] leading-relaxed text-muted">
          Limits (max position, slippage, price impact, capital) are enforced on the server from your trading settings. Small-cap tokens can lose most of their value quickly.
        </p>
      </CardBody>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent title="Confirm transaction" description={`Your ${signer.walletLabel()} will ask you to approve this swap on ${meta.name}.`}>
          {q && (
            <div className="space-y-3 text-sm">
              <dl className="space-y-1.5 rounded-md border border-border bg-surface2 p-3 text-xs">
                <Row k="Action" v={`Buy ${symbol} on ${meta.name}`} />
                <Row k="Spend" v={usd(Number(amount))} />
                <Row k="You receive (est.)" v={`${q.quote.outputAmount.toLocaleString(undefined, { maximumFractionDigits: 2 })} ${symbol}`} />
                <Row k="Minimum received" v={`${q.quote.minReceived.toLocaleString(undefined, { maximumFractionDigits: 2 })} ${symbol}`} />
                <Row k="Price impact" v={`${q.quote.priceImpactPct.toFixed(2)}%`} />
                <Row k="Slippage tolerance" v={`${(q.quote.slippageBps / 100).toFixed(2)}%`} />
                <Row k="Fees" v={usd(q.quote.networkFeeUsd + q.quote.priorityFeeUsd + q.quote.platformFeeUsd, 4)} />
                <Row k="Environment" v="LIVE" />
              </dl>
              {q.analysis.warnings.length > 0 && <p className="text-xs text-warn">Warnings: {q.analysis.warnings.slice(0, 3).join("; ")}</p>}
              <p className="text-xs text-muted">This position will NOT be sold automatically for being at a loss. Exits happen only at your configured profit targets or via emergency protection (if enabled).</p>
              <div className="flex gap-2">
                <Button variant="outline" className="flex-1" onClick={() => setOpen(false)}>Cancel</Button>
                <Button variant="buy" className="flex-1" disabled={busy} onClick={confirm}>{busy ? "Working…" : "Confirm buy"}</Button>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </Card>
  );
}

function Row({ k, v, warn }: { k: string; v: string; warn?: boolean }) {
  return (
    <div className="flex justify-between gap-3">
      <dt className="text-muted">{k}</dt>
      <dd className={`num text-right ${warn ? "text-warn" : ""}`}>{v}</dd>
    </div>
  );
}
