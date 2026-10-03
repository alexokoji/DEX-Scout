"use client";

import { useWallet } from "@solana/wallet-adapter-react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";
import { useConnectWallet } from "@/components/layout/ConnectWallet";
import { useEvmWallet } from "@/components/layout/EvmWalletProvider";
import { Badge } from "@/components/ui/badges";
import { Button } from "@/components/ui/button";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { shortAddr } from "@/lib/format";
import { bytesToB64 } from "./useSigner";

type Family = "solana" | "evm";

/** Signature-verified wallet linking. One wallet connection can cover both chain families; each address is linked separately. */
export function WalletPanel({ linked }: { linked: { address: string; family: string }[] }) {
  const router = useRouter();
  const sol = useWallet();
  const evm = useEvmWallet();
  const connectUi = useConnectWallet();
  const [busy, setBusy] = useState<Family | null>(null);

  const isLinked = (family: Family, addr: string | null | undefined) => !!addr && linked.some((l) => l.family === family && l.address.toLowerCase() === addr.toLowerCase());

  async function verify(family: Family) {
    const address = family === "solana" ? sol.publicKey?.toBase58() : evm.address;
    if (!address) return;
    setBusy(family);
    try {
      const c = await fetch("/api/wallet/challenge", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ family, address }) });
      const cj = await c.json();
      if (!c.ok) throw new Error(cj.error ?? "Could not start verification");
      let signature: string;
      if (family === "solana") {
        if (!sol.signMessage) throw new Error("This wallet does not support message signing");
        signature = bytesToB64(await sol.signMessage(new TextEncoder().encode(cj.message)));
      } else {
        signature = await evm.signMessage(cj.message);
      }
      const r = await fetch("/api/wallet", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ family, address, challenge: cj.challenge, signature }) });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error ?? "Verification failed");
      toast.success("Wallet verified and linked");
      router.refresh();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Verification failed");
    } finally {
      setBusy(null);
    }
  }

  const solAddr = sol.publicKey?.toBase58() ?? null;
  const rows: { family: Family; label: string; address: string }[] = [];
  if (evm.address) rows.push({ family: "evm", label: "Ethereum, Base, BNB Chain, Arbitrum, Polygon", address: evm.address });
  if (sol.connected && solAddr) rows.push({ family: "solana", label: "Solana", address: solAddr });

  return (
    <Card>
      <CardHeader title="Connected wallet" sub="One connection covers every chain your wallet supports — MetaMask, Phantom, Coinbase Wallet, Backpack, Rabby and others. Each address must be verified once before it can trade." />
      <CardBody className="space-y-3 text-sm">
        {rows.length === 0 ? (
          <div className="space-y-2">
            <p className="text-xs text-muted">No wallet connected.</p>
            <Button onClick={connectUi.open}>Connect wallet</Button>
          </div>
        ) : (
          <>
            {rows.map((r) => (
              <div key={r.family} className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-border bg-surface2 px-3 py-2">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="num">{shortAddr(r.address)}</span>
                  <span className="text-xs text-muted">{r.label}</span>
                  <Badge tone="green">connected</Badge>
                  {isLinked(r.family, r.address) ? <Badge tone="blue">verified</Badge> : <Badge tone="amber">not verified</Badge>}
                </div>
                {!isLinked(r.family, r.address) && (
                  <Button size="sm" onClick={() => verify(r.family)} disabled={busy === r.family}>
                    {busy === r.family ? "Waiting for wallet…" : "Verify & link"}
                  </Button>
                )}
              </div>
            ))}
            <Button variant="outline" size="sm" onClick={connectUi.open}>Manage / add another wallet</Button>
          </>
        )}
      </CardBody>
    </Card>
  );
}
