"use client";

import { ConnectionProvider, WalletProvider } from "@solana/wallet-adapter-react";
import { WalletModalProvider } from "@solana/wallet-adapter-react-ui";
import "@solana/wallet-adapter-react-ui/styles.css";
import { useMemo } from "react";
import { EvmWalletProvider } from "./EvmWalletProvider";

/**
 * Solana: Wallet Standard auto-detection. EVM: injected EIP-1193 wallets via EvmWalletProvider. Phantom, Solflare, Backpack and any other standards-compliant wallet appear
 * without bundling per-wallet adapters. The wallet only ever signs; keys never reach this app.
 */
export function WalletProviders({ children }: { children: React.ReactNode }) {
  const endpoint = useMemo(() => process.env.NEXT_PUBLIC_SOLANA_RPC_URL || "https://api.mainnet-beta.solana.com", []);
  return (
    <ConnectionProvider endpoint={endpoint}>
      <WalletProvider wallets={[]} autoConnect>
        <WalletModalProvider>
          <EvmWalletProvider>{children}</EvmWalletProvider>
        </WalletModalProvider>
      </WalletProvider>
    </ConnectionProvider>
  );
}
