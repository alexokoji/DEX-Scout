"use client";

import { useWallet } from "@solana/wallet-adapter-react";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badges";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent } from "@/components/ui/form";
import { shortAddr } from "@/lib/format";
import { connectSolanaWallet as connectSolana, type SolLike } from "@/lib/solanaConnect";
import { useEvmWallet } from "./EvmWalletProvider";

/**
 * ONE connect-wallet experience for every chain. Modern wallets (MetaMask, Phantom, Coinbase Wallet, Backpack...)
 * are multichain, so asking the user to "connect Solana" and "connect EVM" separately was wrong: the list below
 * merges what the browser reports for EVM (EIP-6963) and Solana (Wallet Standard) by wallet name, and choosing a
 * wallet connects every chain family that wallet supports. Wallets only ever sign; keys never reach this app.
 */

interface Entry {
  key: string;
  name: string;
  icon: string | null;
  evmId?: string;
  solName?: string;
}

const norm = (n: string) => n.toLowerCase().replace(/\s*wallet\s*$/, "").trim();

interface ConnectUi {
  open(): void;
  /**
   * Connect what an action needs, without a dead-end "please connect": EVM re-uses the wallet already in use (or the last one),
   * Solana goes through the SAME wallet when it supports Solana (MetaMask, Phantom, Coinbase...), else the dialog opens.
   * Resolves true once that family is connected.
   */
  connectFamily(family: "evm" | "solana"): Promise<boolean>;
}
const Ctx = createContext<ConnectUi | null>(null);

export function useConnectWallet(): ConnectUi {
  const v = useContext(Ctx);
  if (!v) throw new Error("useConnectWallet must be used inside ConnectWalletProvider");
  return v;
}

function friendly(e: unknown): string {
  const m = e instanceof Error ? e.message : String(e);
  return /reject|denied|cancel|closed/i.test(m) ? "Connection was cancelled in the wallet" : m;
}

export function ConnectWalletProvider({ children }: { children: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const sol = useWallet();
  const evm = useEvmWallet();
  // the wallet-adapter state changes across renders; async connect code needs the CURRENT one, not the one it started with
  const solRef = useRef(sol);
  useEffect(() => {
    solRef.current = sol;
  });

  /** See lib/solanaConnect.ts: waits for the provider to bind the wallet before connecting, so the app's Solana state follows. */
  const connectSolanaWallet = useCallback((name: string) => connectSolana(() => solRef.current as unknown as SolLike, name), []);

  const entries = useMemo<Entry[]>(() => {
    const map = new Map<string, Entry>();
    for (const w of evm.wallets) {
      const key = norm(w.name);
      map.set(key, { key, name: w.name, icon: w.icon, evmId: w.id });
    }
    for (const w of sol.wallets) {
      if (w.readyState !== "Installed" && w.readyState !== "Loadable") continue;
      const key = norm(w.adapter.name);
      const prev = map.get(key);
      map.set(key, { key, name: prev?.name ?? w.adapter.name, icon: prev?.icon ?? w.adapter.icon ?? null, evmId: prev?.evmId, solName: w.adapter.name });
    }
    return [...map.values()].sort((a, b) => Number(!!b.evmId && !!b.solName) - Number(!!a.evmId && !!a.solName) || a.name.localeCompare(b.name));
  }, [evm.wallets, sol.wallets]);

  const solAddress = sol.publicKey?.toBase58() ?? null;
  const connectedKeys = new Set([evm.activeWallet ? norm(evm.activeWallet.name) : null, sol.wallet ? norm(sol.wallet.adapter.name) : null].filter(Boolean) as string[]);

  const connect = useCallback(
    async (e: Entry) => {
      setBusyKey(e.key);
      const connected: string[] = [];
      const failed: string[] = [];
      // sequential, so the wallet never shows two prompts at once
      if (e.evmId) {
        try {
          await evm.connect(e.evmId);
          connected.push("EVM chains");
        } catch (err) {
          failed.push(`EVM: ${friendly(err)}`);
        }
      }
      if (e.solName) {
        try {
          await connectSolanaWallet(e.solName);
          connected.push("Solana");
        } catch (err) {
          failed.push(`Solana: ${friendly(err)}`);
        }
      }
      setBusyKey(null);
      if (connected.length) toast.success(`${e.name} connected (${connected.join(" + ")})`);
      if (failed.length && !connected.length) toast.error(failed[0]);
      else if (failed.length) toast.message(`Some chains were skipped — ${failed.join("; ")}`);
      if (connected.length) setOpen(false);
    },
    [evm, connectSolanaWallet],
  );

  const evmRef = useRef(evm);
  useEffect(() => {
    evmRef.current = evm;
  });
  const entriesRef = useRef(entries);
  useEffect(() => {
    entriesRef.current = entries;
  });

  const connectFamily = useCallback(
    async (family: "evm" | "solana"): Promise<boolean> => {
      try {
        if (family === "evm") {
          if (evmRef.current.address) return true;
          await evmRef.current.connect();
          return true;
        }
        if (solRef.current.connected) return true;
        // prefer the wallet already connected for EVM if it also supports Solana, then the one selected for Solana
        const active = evmRef.current.activeWallet ? norm(evmRef.current.activeWallet.name) : null;
        const via = entriesRef.current.find((e) => e.key === active && e.solName)?.solName ?? solRef.current.wallet?.adapter.name ?? null;
        if (!via) {
          setOpen(true);
          return false;
        }
        await connectSolanaWallet(via);
        return true;
      } catch (err) {
        toast.error(friendly(err));
        setOpen(true);
        return false;
      }
    },
    [connectSolanaWallet],
  );

  const ui = useMemo<ConnectUi>(() => ({ open: () => setOpen(true), connectFamily }), [connectFamily]);
  const anyConnected = !!evm.address || sol.connected;

  return (
    <Ctx.Provider value={ui}>
      {children}
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent title={anyConnected ? "Your wallet" : "Connect wallet"} description="One connection covers every chain the wallet supports — Solana and all the EVM chains.">
          <div className="space-y-4">
            {anyConnected && (
              <div className="space-y-2 rounded-md border border-border bg-surface2 p-3 text-xs">
                {evm.address && (
                  <div className="flex items-center justify-between gap-2">
                    <span><span className="text-muted">EVM chains · </span><span className="num">{shortAddr(evm.address)}</span>{evm.activeWallet ? <span className="text-muted"> · {evm.activeWallet.name}</span> : null}</span>
                    <Button size="sm" variant="ghost" onClick={() => evm.disconnect()}>Disconnect</Button>
                  </div>
                )}
                {sol.connected && solAddress && (
                  <div className="flex items-center justify-between gap-2">
                    <span><span className="text-muted">Solana · </span><span className="num">{shortAddr(solAddress)}</span>{sol.wallet ? <span className="text-muted"> · {sol.wallet.adapter.name}</span> : null}</span>
                    <Button size="sm" variant="ghost" onClick={() => void sol.disconnect()}>Disconnect</Button>
                  </div>
                )}
              </div>
            )}

            {entries.length === 0 ? (
              <div className="space-y-2 text-sm">
                <p className="text-muted">No wallet detected in this browser.</p>
                <p className="text-xs text-muted">
                  Install a multichain wallet such as{" "}
                  <a className="text-accent" href="https://metamask.io/download" target="_blank" rel="noreferrer">MetaMask</a>,{" "}
                  <a className="text-accent" href="https://phantom.com/download" target="_blank" rel="noreferrer">Phantom</a> or{" "}
                  <a className="text-accent" href="https://www.coinbase.com/wallet/downloads" target="_blank" rel="noreferrer">Coinbase Wallet</a>, then reload this page.
                </p>
              </div>
            ) : (
              <ul className="space-y-1.5">
                {entries.map((e) => (
                  <li key={e.key}>
                    <button
                      className="flex w-full items-center gap-3 rounded-md border border-border bg-surface px-3 py-2.5 text-left text-sm hover:border-accent disabled:opacity-60"
                      disabled={busyKey !== null}
                      onClick={() => void connect(e)}
                    >
                      {e.icon ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img src={e.icon} alt="" className="h-6 w-6 rounded" />
                      ) : (
                        <span className="h-6 w-6 rounded bg-surface2" />
                      )}
                      <span className="flex-1 font-medium">{e.name}</span>
                      {connectedKeys.has(e.key) && <Badge tone="green">connected</Badge>}
                      {busyKey === e.key ? (
                        <span className="text-xs text-muted">Check your wallet…</span>
                      ) : (
                        <span className="flex gap-1">
                          {e.evmId && <Badge>EVM</Badge>}
                          {e.solName && <Badge>Solana</Badge>}
                        </span>
                      )}
                    </button>
                  </li>
                ))}
              </ul>
            )}
            <p className="text-[11px] leading-relaxed text-muted">DEX Scout never asks for seed phrases or private keys. Your wallet only signs; connecting does not move funds.</p>
          </div>
        </DialogContent>
      </Dialog>
    </Ctx.Provider>
  );
}

/** The single wallet button for the whole app. */
export function ConnectWalletButton() {
  const { open } = useConnectWallet();
  const evm = useEvmWallet();
  const sol = useWallet();
  const solAddress = sol.publicKey?.toBase58() ?? null;
  const primary = evm.address ?? solAddress;
  const both = !!evm.address && !!solAddress;
  return (
    <button
      className="h-9 whitespace-nowrap rounded-md border border-border bg-surface2 px-3 text-xs font-medium hover:border-accent"
      title={primary ? [evm.address && `EVM: ${evm.address}`, solAddress && `Solana: ${solAddress}`].filter(Boolean).join("\n") : "Connect a wallet (Solana + all EVM chains)"}
      onClick={open}
    >
      {primary ? (
        <span className="flex items-center gap-1.5">
          <span className="h-1.5 w-1.5 rounded-full bg-up" />
          <span className="num">{shortAddr(primary)}</span>
          {both && <span className="text-muted">+1</span>}
        </span>
      ) : (
        "Connect wallet"
      )}
    </button>
  );
}
