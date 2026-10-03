"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { CHAINS } from "@/core/chains";

/** Minimal EIP-1193 provider surface (MetaMask, Rabby, Coinbase Wallet, Phantom EVM, Brave, ...). */
interface Eip1193 {
  request(args: { method: string; params?: unknown[] | object }): Promise<unknown>;
  on?(event: string, handler: (...args: never[]) => void): void;
  removeListener?(event: string, handler: (...args: never[]) => void): void;
}

/** EIP-6963: every installed wallet announces itself, so several can coexist without fighting over window.ethereum. */
interface Eip6963Detail {
  info: { uuid: string; name: string; icon: string; rdns: string };
  provider: Eip1193;
}

export interface EvmWalletInfo {
  id: string;
  name: string;
  icon: string | null;
}

export interface EvmTx {
  to: string;
  data?: string;
  value?: string;
  gas?: string;
}

interface EvmWalletApi {
  available: boolean;
  /** every EVM wallet detected in this browser */
  wallets: EvmWalletInfo[];
  /** the wallet the current address came from */
  activeWallet: EvmWalletInfo | null;
  address: string | null;
  connect(walletId?: string): Promise<string>;
  disconnect(): void;
  signMessage(message: string): Promise<string>;
  switchChain(chainId: number): Promise<void>;
  sendTransaction(tx: EvmTx): Promise<string>;
  waitForReceipt(hash: string, timeoutMs?: number): Promise<boolean>;
}

const Ctx = createContext<EvmWalletApi | null>(null);
const LAST_KEY = "dexscout:evm-wallet";
const LEGACY_ID = "window.ethereum";
const legacyEthereum = (): Eip1193 | null => (typeof window === "undefined" ? null : ((window as unknown as { ethereum?: Eip1193 }).ethereum ?? null));

/**
 * Injected-wallet support for every EVM chain. The wallet only ever signs: this app never sees keys, and the
 * "disconnect" here just forgets the address locally (wallets have no programmatic disconnect).
 */
export function EvmWalletProvider({ children }: { children: React.ReactNode }) {
  const providers = useRef(new Map<string, { info: EvmWalletInfo; provider: Eip1193 }>());
  const [wallets, setWallets] = useState<EvmWalletInfo[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [address, setAddress] = useState<string | null>(null);

  const add = useCallback((id: string, info: EvmWalletInfo, provider: Eip1193) => {
    if (providers.current.has(id)) return;
    providers.current.set(id, { info, provider });
    setWallets([...providers.current.values()].map((p) => p.info));
  }, []);

  const providerFor = useCallback((id: string | null): Eip1193 | null => {
    if (id && providers.current.has(id)) return providers.current.get(id)!.provider;
    return legacyEthereum();
  }, []);

  useEffect(() => {
    const onAnnounce = (e: Event) => {
      const d = (e as CustomEvent<Eip6963Detail>).detail;
      if (d?.info && d.provider) add(d.info.rdns || d.info.uuid, { id: d.info.rdns || d.info.uuid, name: d.info.name, icon: d.info.icon ?? null }, d.provider);
    };
    window.addEventListener("eip6963:announceProvider", onAnnounce);
    window.dispatchEvent(new Event("eip6963:requestProvider"));

    // wallets that predate EIP-6963 only expose window.ethereum; give them a slot only if nothing announced
    const legacyTimer = setTimeout(() => {
      const eth = legacyEthereum();
      if (eth && providers.current.size === 0) add(LEGACY_ID, { id: LEGACY_ID, name: "Browser wallet", icon: null }, eth);
      // silently restore the last connection (eth_accounts never prompts)
      let last: string | null = null;
      try { last = localStorage.getItem(LAST_KEY); } catch { /* storage blocked */ }
      const id = last && providers.current.has(last) ? last : null;
      const p = id ? providers.current.get(id)!.provider : null;
      if (id && p) {
        p.request({ method: "eth_accounts" })
          .then((a) => {
            const first = (a as string[])[0];
            if (first) {
              setActiveId(id);
              setAddress(first);
            }
          })
          .catch(() => {});
      }
    }, 400);
    return () => {
      clearTimeout(legacyTimer);
      window.removeEventListener("eip6963:announceProvider", onAnnounce);
    };
  }, [add]);

  // follow account switches made inside the wallet itself
  useEffect(() => {
    const p = providerFor(activeId);
    if (!p || !activeId) return;
    const onAccounts = (accounts: string[]) => setAddress(accounts[0] ?? null);
    p.on?.("accountsChanged", onAccounts as never);
    return () => p.removeListener?.("accountsChanged", onAccounts as never);
  }, [activeId, providerFor]);

  const connect = useCallback(
    async (walletId?: string) => {
      const id = walletId ?? activeId ?? wallets[0]?.id ?? null;
      const p = providerFor(id);
      if (!p) throw new Error("No EVM-compatible wallet found in this browser. Install a wallet such as MetaMask, Rabby, Phantom or Coinbase Wallet.");
      const accounts = (await p.request({ method: "eth_requestAccounts" })) as string[];
      setActiveId(id ?? LEGACY_ID);
      setAddress(accounts[0] ?? null);
      try { localStorage.setItem(LAST_KEY, id ?? LEGACY_ID); } catch { /* storage blocked */ }
      return accounts[0];
    },
    [activeId, wallets, providerFor],
  );

  const api = useMemo<EvmWalletApi>(
    () => ({
      available: wallets.length > 0,
      wallets,
      activeWallet: wallets.find((w) => w.id === activeId) ?? null,
      address,
      connect,
      disconnect: () => {
        setAddress(null);
        setActiveId(null);
        try { localStorage.removeItem(LAST_KEY); } catch { /* storage blocked */ }
      },
      async signMessage(message) {
        const eth = providerFor(activeId);
        if (!eth || !address) throw new Error("Connect your wallet first");
        return (await eth.request({ method: "personal_sign", params: [message, address] })) as string;
      },
      async switchChain(chainId) {
        const eth = providerFor(activeId);
        if (!eth) throw new Error("No EVM wallet found");
        const hex = "0x" + chainId.toString(16);
        const current = (await eth.request({ method: "eth_chainId" })) as string;
        if (current.toLowerCase() === hex) return;
        try {
          await eth.request({ method: "wallet_switchEthereumChain", params: [{ chainId: hex }] });
        } catch (e) {
          // Newer networks (Robinhood Chain, HyperEVM, Monad, ...) aren't built into wallets: 4902 = "unknown chain".
          // Offer to add it (the wallet shows its own confirmation), which also switches to it.
          const code = (e as { code?: number }).code;
          const unknown = code === 4902 || /unrecognized chain|not been added|unknown chain/i.test((e as Error)?.message ?? "");
          const meta = Object.values(CHAINS).find((c) => c.evmChainId === chainId);
          if (!unknown || !meta) throw e;
          await eth.request({
            method: "wallet_addEthereumChain",
            params: [{
              chainId: hex,
              chainName: meta.name,
              nativeCurrency: { name: meta.nativeSymbol, symbol: meta.nativeSymbol, decimals: 18 },
              rpcUrls: [meta.defaultRpc, ...meta.fallbackRpcs].filter((u) => u.startsWith("https://")),
              blockExplorerUrls: [meta.explorer],
            }],
          });
        }
      },
      async sendTransaction(tx) {
        const eth = providerFor(activeId);
        if (!eth || !address) throw new Error("Connect your wallet first");
        return (await eth.request({ method: "eth_sendTransaction", params: [{ from: address, ...tx }] })) as string;
      },
      async waitForReceipt(hash, timeoutMs = 120_000) {
        const eth = providerFor(activeId);
        if (!eth) return false;
        const end = Date.now() + timeoutMs;
        while (Date.now() < end) {
          const r = (await eth.request({ method: "eth_getTransactionReceipt", params: [hash] })) as { status?: string } | null;
          if (r) return r.status === "0x1";
          await new Promise((res) => setTimeout(res, 2500));
        }
        return false;
      },
    }),
    [wallets, activeId, address, connect, providerFor],
  );

  return <Ctx.Provider value={api}>{children}</Ctx.Provider>;
}

export function useEvmWallet(): EvmWalletApi {
  const v = useContext(Ctx);
  if (!v) throw new Error("useEvmWallet must be used inside EvmWalletProvider");
  return v;
}
