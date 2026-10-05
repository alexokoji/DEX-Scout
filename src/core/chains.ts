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
  /** KyberSwap aggregator URL slug, if Kyber routes this chain (free, no key). */
  kyberSlug?: string;
  /** ParaSwap (Velora) routes this chain (free, no key). */
  paraswap?: boolean;
  /** CoW Protocol network slug, if CoW (keyless limit orders, used for auto-sell) serves this chain. */
  cowNetwork?: string;
  /** KyberSwap's keyless limit-order service serves this chain (used for auto-sell where CoW doesn't). */
  kyberLimitOrders?: boolean;
  /** The native token is the same asset as another chain's (ETH on L2s), so take its USD price from there. */
  nativeUsdFrom?: ChainId;
}

export const NATIVE_EVM = "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE";

type EvmSpec = Omit<ChainMeta, "family" | "rpcEnv" | "id"> & { id: ChainId };
const evm = (s: EvmSpec): ChainMeta => ({ ...s, family: "evm", rpcEnv: `${s.id.toUpperCase()}_RPC_URL` });

const WETH_OP = "0x4200000000000000000000000000000000000006"; // canonical WETH on OP-stack chains

export const CHAINS: Record<ChainId, ChainMeta> = {
  solana: { id: "solana", name: "Solana", family: "svm", nativeSymbol: "SOL", evmChainId: null, dexScreenerId: "solana", geckoId: "solana", explorer: "https://solscan.io", rpcEnv: "SOLANA_RPC_URL", defaultRpc: "https://solana-rpc.publicnode.com", fallbackRpcs: ["https://api.mainnet-beta.solana.com"], wrappedNative: "So11111111111111111111111111111111111111112", mockNativeUsd: 150, typicalFeeUsd: 0.02 },

  // --- the original EVM chains (free swap routing on both aggregators)
  ethereum: evm({ id: "ethereum", name: "Ethereum", nativeSymbol: "ETH", evmChainId: 1, dexScreenerId: "ethereum", geckoId: "eth", explorer: "https://etherscan.io", defaultRpc: "https://ethereum-rpc.publicnode.com", fallbackRpcs: ["https://gateway.tenderly.co/public/mainnet", "https://eth.drpc.org", "https://1rpc.io/eth"], wrappedNative: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2", mockNativeUsd: 3000, typicalFeeUsd: 4, kyberSlug: "ethereum", paraswap: true, cowNetwork: "mainnet", kyberLimitOrders: true }),
  base: evm({ id: "base", name: "Base", nativeSymbol: "ETH", evmChainId: 8453, dexScreenerId: "base", geckoId: "base", explorer: "https://basescan.org", defaultRpc: "https://base-rpc.publicnode.com", fallbackRpcs: ["https://gateway.tenderly.co/public/base", "https://1rpc.io/base", "https://base.drpc.org"], wrappedNative: WETH_OP, mockNativeUsd: 3000, typicalFeeUsd: 0.06, kyberSlug: "base", paraswap: true, nativeUsdFrom: "ethereum", cowNetwork: "base", kyberLimitOrders: true }),
  bsc: evm({ id: "bsc", name: "BNB Chain", nativeSymbol: "BNB", evmChainId: 56, dexScreenerId: "bsc", geckoId: "bsc", explorer: "https://bscscan.com", defaultRpc: "https://bsc-rpc.publicnode.com", fallbackRpcs: ["https://bsc.drpc.org", "https://1rpc.io/bnb", "https://bsc-dataseed1.defibit.io"], wrappedNative: "0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c", mockNativeUsd: 600, typicalFeeUsd: 0.12, kyberSlug: "bsc", paraswap: true, cowNetwork: "bnb", kyberLimitOrders: true }),
  arbitrum: evm({ id: "arbitrum", name: "Arbitrum", nativeSymbol: "ETH", evmChainId: 42161, dexScreenerId: "arbitrum", geckoId: "arbitrum", explorer: "https://arbiscan.io", defaultRpc: "https://arbitrum-one-rpc.publicnode.com", fallbackRpcs: ["https://gateway.tenderly.co/public/arbitrum", "https://arbitrum.drpc.org", "https://arb1.arbitrum.io/rpc"], wrappedNative: "0x82aF49447D8a07e3bd95BD0d56f35241523fBab1", mockNativeUsd: 3000, typicalFeeUsd: 0.1, kyberSlug: "arbitrum", paraswap: true, nativeUsdFrom: "ethereum", cowNetwork: "arbitrum_one", kyberLimitOrders: true }),
  polygon: evm({ id: "polygon", name: "Polygon", nativeSymbol: "POL", evmChainId: 137, dexScreenerId: "polygon", geckoId: "polygon_pos", explorer: "https://polygonscan.com", defaultRpc: "https://polygon.drpc.org", fallbackRpcs: ["https://gateway.tenderly.co/public/polygon", "https://1rpc.io/matic", "https://polygon-bor-rpc.publicnode.com"], wrappedNative: "0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270", mockNativeUsd: 0.5, typicalFeeUsd: 0.03, kyberSlug: "polygon", paraswap: true, cowNetwork: "polygon", kyberLimitOrders: true }),

  // --- added chains with a free swap route (KyberSwap and/or ParaSwap, no key)
  robinhood: evm({ id: "robinhood", name: "Robinhood Chain", nativeSymbol: "ETH", evmChainId: 4663, dexScreenerId: "robinhood", geckoId: "robinhood", explorer: "https://robinscan.io", defaultRpc: "https://rpc.mainnet.chain.robinhood.com", fallbackRpcs: ["https://robinhood-rpc.publicnode.com", "https://rpc.ordofi.network", "https://robinhood.drpc.org"], wrappedNative: "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73", mockNativeUsd: 3000, typicalFeeUsd: 0.05, kyberSlug: "robinhood", paraswap: true, nativeUsdFrom: "ethereum", kyberLimitOrders: true }),
  avalanche: evm({ id: "avalanche", name: "Avalanche", nativeSymbol: "AVAX", evmChainId: 43114, dexScreenerId: "avalanche", geckoId: "avax", explorer: "https://snowscan.xyz", defaultRpc: "https://api.avax.network/ext/bc/C/rpc", fallbackRpcs: ["https://avalanche-c-chain-rpc.publicnode.com"], wrappedNative: "0xB31f66AA3C1e785363F0875A1B74E27b85FD66c7", mockNativeUsd: 25, typicalFeeUsd: 0.05, kyberSlug: "avalanche", paraswap: true, cowNetwork: "avalanche", kyberLimitOrders: true }),
  optimism: evm({ id: "optimism", name: "Optimism", nativeSymbol: "ETH", evmChainId: 10, dexScreenerId: "optimism", geckoId: "optimism", explorer: "https://optimistic.etherscan.io", defaultRpc: "https://optimism-rpc.publicnode.com", fallbackRpcs: ["https://mainnet.optimism.io", "https://optimism.gateway.tenderly.co", "https://optimism.drpc.org"], wrappedNative: WETH_OP, mockNativeUsd: 3000, typicalFeeUsd: 0.05, kyberSlug: "optimism", paraswap: true, nativeUsdFrom: "ethereum", kyberLimitOrders: true }),
  unichain: evm({ id: "unichain", name: "Unichain", nativeSymbol: "ETH", evmChainId: 130, dexScreenerId: "unichain", geckoId: "unichain", explorer: "https://uniscan.xyz", defaultRpc: "https://unichain-rpc.publicnode.com", fallbackRpcs: ["https://mainnet.unichain.org"], wrappedNative: WETH_OP, mockNativeUsd: 3000, typicalFeeUsd: 0.03, kyberSlug: "unichain", paraswap: true, nativeUsdFrom: "ethereum", kyberLimitOrders: true }),
  linea: evm({ id: "linea", name: "Linea", nativeSymbol: "ETH", evmChainId: 59144, dexScreenerId: "linea", geckoId: "linea", explorer: "https://lineascan.build", defaultRpc: "https://linea-rpc.publicnode.com", fallbackRpcs: ["https://rpc.linea.build"], wrappedNative: "0xe5D7C2a44FfDDf6b295A15c148167daaAf5Cf34f", mockNativeUsd: 3000, typicalFeeUsd: 0.1, kyberSlug: "linea", nativeUsdFrom: "ethereum", cowNetwork: "linea", kyberLimitOrders: true }),
  sonic: evm({ id: "sonic", name: "Sonic", nativeSymbol: "S", evmChainId: 146, dexScreenerId: "sonic", geckoId: "sonic", explorer: "https://sonicscan.org", defaultRpc: "https://sonic-rpc.publicnode.com", fallbackRpcs: ["https://rpc.soniclabs.com", "https://sonic.drpc.org"], wrappedNative: "0x039e2fB66102314Ce7b64Ce5Ce3E5183bc94aD38", mockNativeUsd: 0.5, typicalFeeUsd: 0.01, kyberSlug: "sonic", kyberLimitOrders: true }),
  berachain: evm({ id: "berachain", name: "Berachain", nativeSymbol: "BERA", evmChainId: 80094, dexScreenerId: "berachain", geckoId: "berachain", explorer: "https://berascan.com", defaultRpc: "https://berachain-rpc.publicnode.com", fallbackRpcs: ["https://rpc.berachain.com", "https://rpc.berachain-apis.com"], wrappedNative: "0x6969696969696969696969696969696969696969", mockNativeUsd: 3, typicalFeeUsd: 0.02, kyberSlug: "berachain", kyberLimitOrders: true }),
  hyperevm: evm({ id: "hyperevm", name: "HyperEVM", nativeSymbol: "HYPE", evmChainId: 999, dexScreenerId: "hyperevm", geckoId: "hyperevm", explorer: "https://hyperevmscan.io", defaultRpc: "https://hyperliquid-rpc.publicnode.com", fallbackRpcs: ["https://rpc.hyperliquid.xyz/evm"], wrappedNative: "0x5555555555555555555555555555555555555555", mockNativeUsd: 30, typicalFeeUsd: 0.02, kyberSlug: "hyperevm", kyberLimitOrders: true }),

  // --- added chains with NO free swap route: they are scanned and scored like any other, but building a swap there
  // needs a (free-tier) 0x API key. See hasFreeSwapRoute().
  ink: evm({ id: "ink", name: "Ink", nativeSymbol: "ETH", evmChainId: 57073, dexScreenerId: "ink", geckoId: "ink", explorer: "https://explorer.inkonchain.com", defaultRpc: "https://rpc-gel.inkonchain.com", fallbackRpcs: ["https://rpc-qnd.inkonchain.com"], wrappedNative: WETH_OP, mockNativeUsd: 3000, typicalFeeUsd: 0.02, nativeUsdFrom: "ethereum", cowNetwork: "ink" }),
  mantle: evm({ id: "mantle", name: "Mantle", nativeSymbol: "MNT", evmChainId: 5000, dexScreenerId: "mantle", geckoId: "mantle", explorer: "https://mantlescan.xyz", defaultRpc: "https://mantle-rpc.publicnode.com", fallbackRpcs: ["https://rpc.mantle.xyz"], wrappedNative: "0x78c1b0C915c4FAA5FffA6CAbf0219DA63d7f4cb8", mockNativeUsd: 0.7, typicalFeeUsd: 0.03 }),
  scroll: evm({ id: "scroll", name: "Scroll", nativeSymbol: "ETH", evmChainId: 534352, dexScreenerId: "scroll", geckoId: "scroll", explorer: "https://scrollscan.com", defaultRpc: "https://scroll-rpc.publicnode.com", fallbackRpcs: ["https://rpc.scroll.io"], wrappedNative: "0x5300000000000000000000000000000000000004", mockNativeUsd: 3000, typicalFeeUsd: 0.1, nativeUsdFrom: "ethereum" }),
  blast: evm({ id: "blast", name: "Blast", nativeSymbol: "ETH", evmChainId: 81457, dexScreenerId: "blast", geckoId: "blast", explorer: "https://blastscan.io", defaultRpc: "https://blast-rpc.publicnode.com", fallbackRpcs: [], wrappedNative: "0x4300000000000000000000000000000000000004", mockNativeUsd: 3000, typicalFeeUsd: 0.05, nativeUsdFrom: "ethereum" }),
  world: evm({ id: "world", name: "World Chain", nativeSymbol: "ETH", evmChainId: 480, dexScreenerId: "worldchain", geckoId: "world-chain", explorer: "https://worldscan.org", defaultRpc: "https://worldchain-mainnet.gateway.tenderly.co", fallbackRpcs: ["https://480.rpc.thirdweb.com", "https://worldchain-mainnet.g.alchemy.com/public"], wrappedNative: WETH_OP, mockNativeUsd: 3000, typicalFeeUsd: 0.02, nativeUsdFrom: "ethereum" }),
  abstract: evm({ id: "abstract", name: "Abstract", nativeSymbol: "ETH", evmChainId: 2741, dexScreenerId: "abstract", geckoId: "abstract", explorer: "https://abscan.org", defaultRpc: "https://api.mainnet.abs.xyz", fallbackRpcs: ["https://abstract.drpc.org", "https://abstract.api.onfinality.io/public", "https://2741.rpc.thirdweb.com"], wrappedNative: "0x3439153EB7AF838Ad19d56E1571FBD09333C2809", mockNativeUsd: 3000, typicalFeeUsd: 0.02, nativeUsdFrom: "ethereum" }),
  monad: evm({ id: "monad", name: "Monad", nativeSymbol: "MON", evmChainId: 143, dexScreenerId: "monad", geckoId: "monad", explorer: "https://monadvision.com", defaultRpc: "https://rpc.monad.xyz", fallbackRpcs: ["https://rpc-mainnet.monadinfra.com"], wrappedNative: "0x3bd359C1119dA7Da1D913D1C4D2B7c461115433A", mockNativeUsd: 0.03, typicalFeeUsd: 0.02, kyberLimitOrders: true }),
};

export const CHAIN_IDS = [
  "solana", "ethereum", "base", "bsc", "arbitrum", "polygon",
  "robinhood", "avalanche", "optimism", "unichain", "linea", "sonic", "berachain", "hyperevm",
  "ink", "mantle", "scroll", "blast", "world", "abstract", "monad",
] as const satisfies readonly ChainId[];

/** The six chains this app originally scanned. Accounts still on exactly this set are migrated to all chains. */
export const ORIGINAL_CHAIN_IDS: readonly ChainId[] = ["solana", "ethereum", "base", "bsc", "arbitrum", "polygon"];

export const isChainId = (v: string): v is ChainId => v in CHAINS;
export const chainMeta = (id: string): ChainMeta => CHAINS[isChainId(id) ? id : "solana"];

/** Whether a swap can be built on this chain without any API key (Solana uses Jupiter, EVM uses Kyber/ParaSwap). */
export const hasFreeSwapRoute = (chain: ChainId): boolean => CHAINS[chain].family === "svm" || !!CHAINS[chain].kyberSlug || !!CHAINS[chain].paraswap;

/** Which limit-order venue can auto-sell on this chain (null = none yet: target sells are queued for the user to sign). */
export const autoSellVenue = (chain: ChainId): "cow" | "kyber" | "jupiter" | null => (CHAINS[chain].family === "svm" ? "jupiter" : CHAINS[chain].cowNetwork ? "cow" : CHAINS[chain].kyberLimitOrders ? "kyber" : null);

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
