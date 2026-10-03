"use client";

import { ConnectionProvider, WalletProvider } from "@solana/wallet-adapter-react";
import { useMemo } from "react";
import { ConnectWalletProvider } from "./ConnectWallet";
import { EvmWalletProvider } from "./EvmWalletProvider";

/**
 * Solana: Wallet Standard auto-detection. EVM: EIP-6963 discovery of injected wallets (EvmWalletProvider). Both feed
 * ONE connect-wallet dialog (ConnectWalletProvider) — multichain wallets like MetaMask and Phantom appear once and
 * connect every chain they support. The wallet only ever signs; keys never reach this app.
 */
export function WalletProviders({ children }: { children: React.ReactNode }) {
  // Browser-side Solana RPC (blockhash, sending, confirmation). PublicNode needs no key, serves exactly those
  // methods and allows browser origins; set NEXT_PUBLIC_SOLANA_RPC_URL to use your own.
  const endpoint = useMemo(() => process.env.NEXT_PUBLIC_SOLANA_RPC_URL || "https://solana-rpc.publicnode.com", []);
  return (
    <ConnectionProvider endpoint={endpoint}>
      <WalletProvider wallets={[]} autoConnect>
        <EvmWalletProvider>
          <ConnectWalletProvider>{children}</ConnectWalletProvider>
        </EvmWalletProvider>
      </WalletProvider>
    </ConnectionProvider>
  );
}
