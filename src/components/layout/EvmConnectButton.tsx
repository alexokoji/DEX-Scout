"use client";

import { toast } from "sonner";
import { shortAddr } from "@/lib/format";
import { useEvmWallet } from "./EvmWalletProvider";

export function EvmConnectButton() {
  const evm = useEvmWallet();
  return (
    <button
      className="h-9 whitespace-nowrap rounded-md border border-border bg-surface2 px-3 text-xs font-medium hover:border-accent"
      title={evm.available ? "Connect an EVM wallet (Ethereum, Base, BNB Chain, Arbitrum, Polygon)" : "No EVM wallet detected in this browser"}
      onClick={() => (evm.address ? evm.disconnect() : evm.connect().catch((e) => toast.error(e instanceof Error ? e.message : "Could not connect")))}
    >
      {evm.address ? `EVM ${shortAddr(evm.address)}` : "Connect EVM"}
    </button>
  );
}
