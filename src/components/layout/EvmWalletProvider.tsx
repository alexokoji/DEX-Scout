"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";

/** Minimal EIP-1193 provider surface (MetaMask, Rabby, Coinbase Wallet, Phantom EVM, Brave, ...). */
interface Eip1193 {
  request(args: { method: string; params?: unknown[] | object }): Promise<unknown>;
  on?(event: string, handler: (...args: never[]) => void): void;
  removeListener?(event: string, handler: (...args: never[]) => void): void;
}

export interface EvmTx {
  to: string;
  data?: string;
  value?: string;
  gas?: string;
}

interface EvmWalletApi {
  available: boolean;
  address: string | null;
  connect(): Promise<string>;
  disconnect(): void;
  signMessage(message: string): Promise<string>;
  switchChain(chainId: number): Promise<void>;
  sendTransaction(tx: EvmTx): Promise<string>;
  waitForReceipt(hash: string, timeoutMs?: number): Promise<boolean>;
}

const Ctx = createContext<EvmWalletApi | null>(null);
const getEthereum = (): Eip1193 | null => (typeof window === "undefined" ? null : ((window as unknown as { ethereum?: Eip1193 }).ethereum ?? null));

/**
 * Injected-wallet support for every EVM chain. The wallet only ever signs: this app never sees keys, and the
 * "disconnect" here just forgets the address locally (wallets have no programmatic disconnect).
 */
export function EvmWalletProvider({ children }: { children: React.ReactNode }) {
  const [address, setAddress] = useState<string | null>(null);
  const [available, setAvailable] = useState(false);

  useEffect(() => {
    const eth = getEthereum();
    void Promise.resolve().then(() => setAvailable(!!eth)); // after mount, to avoid an SSR/hydration mismatch
    if (!eth) return;
    eth.request({ method: "eth_accounts" }).then((a) => setAddress((a as string[])[0] ?? null)).catch(() => {});
    const onAccounts = (accounts: string[]) => setAddress(accounts[0] ?? null);
    eth.on?.("accountsChanged", onAccounts as never);
    return () => eth.removeListener?.("accountsChanged", onAccounts as never);
  }, []);

  const connect = useCallback(async () => {
    const eth = getEthereum();
    if (!eth) throw new Error("No EVM wallet found. Install MetaMask, Rabby or Coinbase Wallet.");
    const accounts = (await eth.request({ method: "eth_requestAccounts" })) as string[];
    setAddress(accounts[0] ?? null);
    return accounts[0];
  }, []);

  const api = useMemo<EvmWalletApi>(
    () => ({
      available,
      address,
      connect,
      disconnect: () => setAddress(null),
      async signMessage(message) {
        const eth = getEthereum();
        if (!eth || !address) throw new Error("Connect an EVM wallet first");
        return (await eth.request({ method: "personal_sign", params: [message, address] })) as string;
      },
      async switchChain(chainId) {
        const eth = getEthereum();
        if (!eth) throw new Error("No EVM wallet found");
        const hex = "0x" + chainId.toString(16);
        const current = (await eth.request({ method: "eth_chainId" })) as string;
        if (current.toLowerCase() === hex) return;
        await eth.request({ method: "wallet_switchEthereumChain", params: [{ chainId: hex }] });
      },
      async sendTransaction(tx) {
        const eth = getEthereum();
        if (!eth || !address) throw new Error("Connect an EVM wallet first");
        return (await eth.request({ method: "eth_sendTransaction", params: [{ from: address, ...tx }] })) as string;
      },
      async waitForReceipt(hash, timeoutMs = 120_000) {
        const eth = getEthereum();
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
    [available, address, connect],
  );

  return <Ctx.Provider value={api}>{children}</Ctx.Provider>;
}

export function useEvmWallet(): EvmWalletApi {
  const v = useContext(Ctx);
  if (!v) throw new Error("useEvmWallet must be used inside EvmWalletProvider");
  return v;
}
