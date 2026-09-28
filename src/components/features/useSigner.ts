"use client";

import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { VersionedTransaction } from "@solana/web3.js";
import { CHAINS } from "@/core/chains";
import type { ChainId } from "@/core/types";
import { useEvmWallet } from "@/components/layout/EvmWalletProvider";

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

  return {
    isConnected(chain: ChainId): boolean {
      return CHAINS[chain].family === "evm" ? !!evm.address : sol.connected;
    },
    walletLabel(chain: ChainId): string {
      return CHAINS[chain].family === "evm" ? "EVM wallet" : "Solana wallet";
    },
    async signAndSend(chain: ChainId, payload: string): Promise<string> {
      if (CHAINS[chain].family === "svm") {
        if (!sol.connected || !sol.sendTransaction) throw new Error("Connect a Solana wallet first");
        return sol.sendTransaction(VersionedTransaction.deserialize(b64ToBytes(payload)), connection);
      }
      if (!evm.address) throw new Error("Connect an EVM wallet first");
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
