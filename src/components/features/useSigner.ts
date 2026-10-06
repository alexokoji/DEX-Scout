"use client";

import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { VersionedTransaction } from "@solana/web3.js";
import { useEffect, useRef } from "react";
import { CHAINS } from "@/core/chains";
import type { ChainId } from "@/core/types";
import { useConnectWallet } from "@/components/layout/ConnectWallet";
import { useEvmWallet } from "@/components/layout/EvmWalletProvider";
import { toast } from "sonner";

const b64ToBytes = (b64: string) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
export const bytesToB64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));

/** Polls until `ready()` is true (React state lands on a later render than the connect call that caused it). */
async function until(ready: () => boolean, timeoutMs = 3000): Promise<boolean> {
  const t0 = Date.now();
  while (!ready()) {
    if (Date.now() - t0 > timeoutMs) return false;
    await new Promise((r) => setTimeout(r, 50));
  }
  return true;
}

/**
 * One signing interface for every chain. Takes the UNSIGNED payload the server prepared and returns the
 * transaction signature/hash after the user's wallet approved and broadcast it. Keys never leave the wallet.
 *
 * The wallet state is read through refs, not from the render that created the click handler: a handler that connects the
 * wallet and then signs (the normal case after a reload) would otherwise sign with the stale "not connected" state it started
 * with, and fail with "connect a wallet" a moment after the wallet had connected.
 */
export function useSigner() {
  const { connection } = useConnection();
  const sol = useWallet();
  const evm = useEvmWallet();
  const connectUi = useConnectWallet();
  const solRef = useRef(sol);
  const evmRef = useRef(evm);
  useEffect(() => {
    solRef.current = sol;
    evmRef.current = evm;
  });

  const evmReady = () => until(() => !!evmRef.current.address);

  return {
    /** The address this browser is connected with for the chain's family: sent with every request so the server checks and trades with THIS wallet, not whichever was linked last. */
    addressFor(chain: ChainId): string | null {
      return CHAINS[chain].family === "evm" ? (evmRef.current.address ?? null) : (solRef.current.publicKey?.toBase58() ?? null);
    },
    isConnected(chain: ChainId): boolean {
      return CHAINS[chain].family === "evm" ? !!evmRef.current.address : solRef.current.connected;
    },
    walletLabel(): string {
      return "wallet";
    },
    /** True when the wallet needed for `chain` is connected; otherwise opens the single connect dialog and says why. */
    async ensureConnected(chain: ChainId): Promise<boolean> {
      const family = CHAINS[chain].family === "evm" ? "evm" : "solana";
      const connected = () => (family === "evm" ? !!evmRef.current.address : solRef.current.connected && !!solRef.current.publicKey);
      if (connected()) return true;
      // not connected (yet, or the wallet locked / was restored late): connect it now through the wallet already in use
      // (one prompt in MetaMask), rather than telling the user to go and do it; the dialog opens only if that isn't possible
      const ok = await connectUi.connectFamily(family);
      if (!ok) {
        toast.error(`Connect a wallet that supports ${CHAINS[chain].name} to continue`);
        return false;
      }
      // connecting resolved, but the app's own state follows on the next render: wait for it, so what runs next sees a connected wallet
      return until(connected);
    },
    /** Auto-sell on EVM: switch to the chain, send the one-time token approval if needed, then sign each order (gasless). */
    async signEvmOrders(chainId: number, approval: { to: string; data: string; value?: string } | null, typedData: unknown[]): Promise<string[]> {
      if (!(await evmReady())) throw new Error("Connect a wallet that supports this chain first");
      const evmNow = () => evmRef.current;
      await evmNow().switchChain(chainId);
      if (approval) {
        const hash = await evmNow().sendTransaction(approval);
        if (!(await evmNow().waitForReceipt(hash))) throw new Error("The token approval was not confirmed");
      }
      const sigs: string[] = [];
      for (const t of typedData) sigs.push(await evmNow().signTypedData(t));
      return sigs;
    },
    /** One EIP-712 signature on the given chain (e.g. cancelling auto-sell orders). */
    async signTyped(chainId: number, typedData: unknown): Promise<string> {
      if (!(await evmReady())) throw new Error("Connect a wallet that supports this chain first");
      await evmRef.current.switchChain(chainId);
      return evmRef.current.signTypedData(typedData);
    },
    async signAndSend(chain: ChainId, payload: string): Promise<string> {
      if (CHAINS[chain].family === "svm") {
        if (!(await until(() => solRef.current.connected && !!solRef.current.sendTransaction))) throw new Error("Connect a wallet that supports Solana first");
        return solRef.current.sendTransaction(VersionedTransaction.deserialize(b64ToBytes(payload)), connection);
      }
      if (!(await evmReady())) throw new Error("Connect a wallet that supports this chain first");
      const p = JSON.parse(payload) as { chainId: number; approval?: { to: string; data: string; value?: string }; tx: { to: string; data: string; value: string; gas?: string } };
      await evmRef.current.switchChain(p.chainId);
      if (p.approval) {
        const ah = await evmRef.current.sendTransaction(p.approval);
        if (!(await evmRef.current.waitForReceipt(ah))) throw new Error("Token approval was not confirmed");
      }
      return evmRef.current.sendTransaction(p.tx);
    },
  };
}
