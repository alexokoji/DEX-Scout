"use client";

import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { VersionedTransaction } from "@solana/web3.js";
import { CHAINS } from "@/core/chains";
import type { ChainId } from "@/core/types";
import { useConnectWallet } from "@/components/layout/ConnectWallet";
import { useEvmWallet } from "@/components/layout/EvmWalletProvider";
import { toast } from "sonner";

const b64ToBytes = (b64: string) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
export const bytesToB64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));

/**
 * One signing interface for every chain. Takes the UNSIGNED payload the server prepared and returns the
 * transaction signature/hash after the user's wallet approved and broadcast it. Keys never leave the wallet.
 */
export function useSigner() {
  const { connection } = useConnection();
  const sol = useWallet();
  const evm = useEvmWallet();
  const connectUi = useConnectWallet();

  return {
    isConnected(chain: ChainId): boolean {
      return CHAINS[chain].family === "evm" ? !!evm.address : sol.connected;
    },
    walletLabel(): string {
      return "wallet";
    },
    /** True when the wallet needed for `chain` is connected; otherwise opens the single connect dialog and says why. */
    ensureConnected(chain: ChainId): boolean {
      const ok = CHAINS[chain].family === "evm" ? !!evm.address : sol.connected;
      if (!ok) {
        toast.error(`Connect a wallet that supports ${CHAINS[chain].name} first`);
        connectUi.open();
      }
      return ok;
    },
    /** Auto-sell on EVM: switch to the chain, send the one-time token approval if needed, then sign each order (gasless). */
    async signEvmOrders(chainId: number, approval: { to: string; data: string; value?: string } | null, typedData: unknown[]): Promise<string[]> {
      if (!evm.address) throw new Error("Connect a wallet that supports this chain first");
      await evm.switchChain(chainId);
      if (approval) {
        const hash = await evm.sendTransaction(approval);
        if (!(await evm.waitForReceipt(hash))) throw new Error("The token approval was not confirmed");
      }
      const sigs: string[] = [];
      for (const t of typedData) sigs.push(await evm.signTypedData(t));
      return sigs;
    },
    /** One EIP-712 signature on the given chain (e.g. cancelling auto-sell orders). */
    async signTyped(chainId: number, typedData: unknown): Promise<string> {
      if (!evm.address) throw new Error("Connect a wallet that supports this chain first");
      await evm.switchChain(chainId);
      return evm.signTypedData(typedData);
    },
    async signAndSend(chain: ChainId, payload: string): Promise<string> {
      if (CHAINS[chain].family === "svm") {
        if (!sol.connected || !sol.sendTransaction) throw new Error("Connect a wallet that supports Solana first");
        return sol.sendTransaction(VersionedTransaction.deserialize(b64ToBytes(payload)), connection);
      }
      if (!evm.address) throw new Error("Connect a wallet that supports this chain first");
      const p = JSON.parse(payload) as { chainId: number; approval?: { to: string; data: string; value?: string }; tx: { to: string; data: string; value: string; gas?: string } };
      await evm.switchChain(p.chainId);
      if (p.approval) {
        const ah = await evm.sendTransaction(p.approval);
        if (!(await evm.waitForReceipt(ah))) throw new Error("Token approval was not confirmed");
      }
      return evm.sendTransaction(p.tx);
    },
  };
}
