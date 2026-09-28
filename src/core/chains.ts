import type { ChainId } from "./types";

export type ChainFamily = "svm" | "evm";

export interface ChainMeta {
  id: ChainId;
  name: string;
  family: ChainFamily;
  nativeSymbol: string;
  /** EVM numeric chain id (null for non-EVM) */
  evmChainId: number | null;
  /** DexScreener chain slug */
  dexScreenerId: string;
  /** GeckoTerminal network slug */
  geckoId: string;
  explorer: string;
  /** env var holding the RPC URL (server side) */
  rpcEnv: string;
  defaultRpc: string;
  wrappedNative: string;
  /** native token USD price used only by MOCK/paper mode */
  mockNativeUsd: number;
  /** typical network fee for one swap in USD, used by MOCK/paper mode */
  typicalFeeUsd: number;
}

export const NATIVE_EVM = "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE";

export const CHAINS: Record<ChainId, ChainMeta> = {
  solana: { id: "solana", name: "Solana", family: "svm", nativeSymbol: "SOL", evmChainId: null, dexScreenerId: "solana", geckoId: "solana", explorer: "https://solscan.io", rpcEnv: "SOLANA_RPC_URL", defaultRpc: "https://api.mainnet-beta.solana.com", wrappedNative: "So11111111111111111111111111111111111111112", mockNativeUsd: 150, typicalFeeUsd: 0.02 },
  ethereum: { id: "ethereum", name: "Ethereum", family: "evm", nativeSymbol: "ETH", evmChainId: 1, dexScreenerId: "ethereum", geckoId: "eth", explorer: "https://etherscan.io", rpcEnv: "ETHEREUM_RPC_URL", defaultRpc: "https://eth.llamarpc.com", wrappedNative: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2", mockNativeUsd: 3000, typicalFeeUsd: 4 },
  base: { id: "base", name: "Base", family: "evm", nativeSymbol: "ETH", evmChainId: 8453, dexScreenerId: "base", geckoId: "base", explorer: "https://basescan.org", rpcEnv: "BASE_RPC_URL", defaultRpc: "https://mainnet.base.org", wrappedNative: "0x4200000000000000000000000000000000000006", mockNativeUsd: 3000, typicalFeeUsd: 0.06 },
  bsc: { id: "bsc", name: "BNB Chain", family: "evm", nativeSymbol: "BNB", evmChainId: 56, dexScreenerId: "bsc", geckoId: "bsc", explorer: "https://bscscan.com", rpcEnv: "BSC_RPC_URL", defaultRpc: "https://bsc-dataseed.binance.org", wrappedNative: "0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c", mockNativeUsd: 600, typicalFeeUsd: 0.12 },
  arbitrum: { id: "arbitrum", name: "Arbitrum", family: "evm", nativeSymbol: "ETH", evmChainId: 42161, dexScreenerId: "arbitrum", geckoId: "arbitrum", explorer: "https://arbiscan.io", rpcEnv: "ARBITRUM_RPC_URL", defaultRpc: "https://arb1.arbitrum.io/rpc", wrappedNative: "0x82aF49447D8a07e3bd95BD0d56f35241523fBab1", mockNativeUsd: 3000, typicalFeeUsd: 0.1 },
  polygon: { id: "polygon", name: "Polygon", family: "evm", nativeSymbol: "POL", evmChainId: 137, dexScreenerId: "polygon", geckoId: "polygon_pos", explorer: "https://polygonscan.com", rpcEnv: "POLYGON_RPC_URL", defaultRpc: "https://polygon-rpc.com", wrappedNative: "0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270", mockNativeUsd: 0.5, typicalFeeUsd: 0.03 },
};

export const CHAIN_IDS = ["solana", "ethereum", "base", "bsc", "arbitrum", "polygon"] as const satisfies readonly ChainId[];
export const isChainId = (v: string): v is ChainId => v in CHAINS;
export const chainMeta = (id: string): ChainMeta => CHAINS[isChainId(id) ? id : "solana"];

/** Normalise an address for storage/lookup: EVM addresses are case-insensitive, Solana are not. */
export function normalizeAddress(chain: ChainId, address: string): string {
  return CHAINS[chain].family === "evm" ? address.toLowerCase() : address;
}