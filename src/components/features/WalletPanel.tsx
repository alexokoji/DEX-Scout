"use client";

import { useWallet } from "@solana/wallet-adapter-react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";
import { EvmConnectButton } from "@/components/layout/EvmConnectButton";
import { useEvmWallet } from "@/components/layout/EvmWalletProvider";
import { Badge } from "@/components/ui/badges";
import { Button } from "@/components/ui/button";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { shortAddr } from "@/lib/format";
import { bytesToB64 } from "./useSigner";

type Family = "solana" | "evm";

/** Signature-verified wallet linking for every supported chain family. */
export function WalletPanel({ linked }: { linked: { address: string; family: string }[] }) {
  const router = useRouter();
  const sol = useWallet();
  const evm = useEvmWallet();
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

  const solAddr = sol.publicKey?.toBase58();
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Card>
        <CardHeader title="Solana wallet" sub="Phantom, Solflare, Backpack and other Wallet Standard wallets. Connect with the button in the top bar." />
        <CardBody className="space-y-3 text-sm">
          {sol.connected && solAddr ? (
            <>
              <div className="flex flex-wrap items-center gap-2">
                <span className="num">{shortAddr(solAddr)}</span>
                <Badge tone="green">connected</Badge>
                {isLinked("solana", solAddr) ? <Badge tone="blue">linked</Badge> : <Badge tone="amber">not linked</Badge>}
              </div>
              {!isLinked("solana", solAddr) && <Button onClick={() => verify("solana")} disabled={busy === "solana"}>{busy === "solana" ? "Waiting for wallet…" : "Verify & link"}</Button>}
            </>
          ) : (
            <p className="text-xs text-muted">No Solana wallet connected. Use “Select Wallet” in the top bar.</p>
          )}
        </CardBody>
      </Card>

      <Card>
        <CardHeader title="EVM wallet" sub="MetaMask, Rabby, Coinbase Wallet and other injected wallets. One address covers Ethereum, Base, BNB Chain, Arbitrum and Polygon." />
        <CardBody className="space-y-3 text-sm">
          {evm.address ? (
            <>
              <div className="flex flex-wrap items-center gap-2">
                <span className="num">{shortAddr(evm.address)}</span>
                <Badge tone="green">connected</Badge>
                {isLinked("evm", evm.address) ? <Badge tone="blue">linked</Badge> : <Badge tone="amber">not linked</Badge>}
              </div>
              {!isLinked("evm", evm.address) && <Button onClick={() => verify("evm")} disabled={busy === "evm"}>{busy === "evm" ? "Waiting for wallet…" : "Verify & link"}</Button>}
            </>
          ) : (
            <div className="space-y-2">
              <p className="text-xs text-muted">{evm.available ? "No EVM wallet connected." : "No EVM wallet detected in this browser."}</p>
              <EvmConnectButton />
            </div>
          )}
        </CardBody>
      </Card>
    </div>
  );
}
