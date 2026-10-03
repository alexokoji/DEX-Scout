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
  /** Free, keyless public endpoint used when the env var is unset. */
  defaultRpc: string;
  /** Further free endpoints tried in order if the ones before them are down, rate-limited or reject the call. */
  fallbackRpcs: string[];
  wrappedNative: string;
  /** native token USD price used only by MOCK/paper mode */
  mockNativeUsd: number;
  /** typical network fee for one swap in USD, used by MOCK/paper mode */
  typicalFeeUsd: number;
}

export const NATIVE_EVM = "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE";

export const CHAINS: Record<ChainId, ChainMeta> = {
  solana: { id: "solana", name: "Solana", family: "svm", nativeSymbol: "SOL", evmChainId: null, dexScreenerId: "solana", geckoId: "solana", explorer: "https://solscan.io", rpcEnv: "SOLANA_RPC_URL", defaultRpc: "https://solana-rpc.publicnode.com", fallbackRpcs: ["https://api.mainnet-beta.solana.com"], wrappedNative: "So11111111111111111111111111111111111111112", mockNativeUsd: 150, typicalFeeUsd: 0.02 },
  ethereum: { id: "ethereum", name: "Ethereum", family: "evm", nativeSymbol: "ETH", evmChainId: 1, dexScreenerId: "ethereum", geckoId: "eth", explorer: "https://etherscan.io", rpcEnv: "ETHEREUM_RPC_URL", defaultRpc: "https://ethereum-rpc.publicnode.com", fallbackRpcs: ["https://gateway.tenderly.co/public/mainnet","https://eth.drpc.org","https://1rpc.io/eth"], wrappedNative: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2", mockNativeUsd: 3000, typicalFeeUsd: 4 },
  base: { id: "base", name: "Base", family: "evm", nativeSymbol: "ETH", evmChainId: 8453, dexScreenerId: "base", geckoId: "base", explorer: "https://basescan.org", rpcEnv: "BASE_RPC_URL", defaultRpc: "https://base-rpc.publicnode.com", fallbackRpcs: ["https://gateway.tenderly.co/public/base","https://1rpc.io/base","https://base.drpc.org"], wrappedNative: "0x4200000000000000000000000000000000000006", mockNativeUsd: 3000, typicalFeeUsd: 0.06 },
  bsc: { id: "bsc", name: "BNB Chain", family: "evm", nativeSymbol: "BNB", evmChainId: 56, dexScreenerId: "bsc", geckoId: "bsc", explorer: "https://bscscan.com", rpcEnv: "BSC_RPC_URL", defaultRpc: "https://bsc-rpc.publicnode.com", fallbackRpcs: ["https://bsc.drpc.org","https://1rpc.io/bnb","https://bsc-dataseed1.defibit.io"], wrappedNative: "0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c", mockNativeUsd: 600, typicalFeeUsd: 0.12 },
  arbitrum: { id: "arbitrum", name: "Arbitrum", family: "evm", nativeSymbol: "ETH", evmChainId: 42161, dexScreenerId: "arbitrum", geckoId: "arbitrum", explorer: "https://arbiscan.io", rpcEnv: "ARBITRUM_RPC_URL", defaultRpc: "https://arbitrum-one-rpc.publicnode.com", fallbackRpcs: ["https://gateway.tenderly.co/public/arbitrum","https://arbitrum.drpc.org","https://arb1.arbitrum.io/rpc"], wrappedNative: "0x82aF49447D8a07e3bd95BD0d56f35241523fBab1", mockNativeUsd: 3000, typicalFeeUsd: 0.1 },
  polygon: { id: "polygon", name: "Polygon", family: "evm", nativeSymbol: "POL", evmChainId: 137, dexScreenerId: "polygon", geckoId: "polygon_pos", explorer: "https://polygonscan.com", rpcEnv: "POLYGON_RPC_URL", defaultRpc: "https://polygon.drpc.org", fallbackRpcs: ["https://gateway.tenderly.co/public/polygon","https://1rpc.io/matic","https://polygon-bor-rpc.publicnode.com"], wrappedNative: "0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270", mockNativeUsd: 0.5, typicalFeeUsd: 0.03 },
};

export const CHAIN_IDS = ["solana", "ethereum", "base", "bsc", "arbitrum", "polygon"] as const satisfies readonly ChainId[];
export const isChainId = (v: string): v is ChainId => v in CHAINS;
export const chainMeta = (id: string): ChainMeta => CHAINS[isChainId(id) ? id : "solana"];

/** Normalise an address for storage/lookup: EVM addresses are case-insensitive, Solana are not. */
export function normalizeAddress(chain: ChainId, address: string): string {
  return CHAINS[chain].family === "evm" ? address.toLowerCase() : address;
}
/**
 * Every RPC endpoint to try for a chain, best first: the operator's own (env var, e.g. a paid/keyed one) if set,
 * then the free keyless default, then the free fallbacks. No key is ever required; a key only makes it faster.
 * (Free public endpoints do come and go — llamarpc and polygon-rpc.com both went dead while this was written —
 * which is why there is always more than one.)
 */
export function rpcCandidates(chain: ChainId): string[] {
  const m = CHAINS[chain];
  return [...new Set([process.env[m.rpcEnv], m.defaultRpc, ...m.fallbackRpcs].filter((u): u is string => !!u && u.trim().length > 0))];
}
