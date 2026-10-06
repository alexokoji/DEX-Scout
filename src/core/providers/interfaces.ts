import type {
  Candle,
  ChainId,
  DataSourceKind,
  OnChainRaw,
  SwapQuote,
  Timeframe,
  TokenSnapshot,
} from "../types";
import type { AiAnalysis, AiInput } from "../ai/schema";

/** Supplies market data. Real implementations wrap DexScreener/Birdeye/etc.; the mock is fully deterministic. */
export interface TokenDataProvider {
  readonly name: string;
  readonly kind: DataSourceKind;
  /** Every token currently visible to the provider. Must not truncate results artificially. */
  discover(chain: ChainId): Promise<TokenSnapshot[]>;
  getSnapshot(chain: ChainId, address: string): Promise<TokenSnapshot | null>;
  /** Optional: current snapshots for tokens we already track (batched, cheap). Providers without it are simply not refreshed. */
  refresh?(chain: ChainId, addresses: string[]): Promise<TokenSnapshot[]>;
  getCandles(chain: ChainId, address: string, timeframe: Timeframe, limit: number): Promise<Candle[]>;
  /** Raw on-chain facts used by the safety + on-chain engines. */
  getOnChain(chain: ChainId, address: string, snapshot: TokenSnapshot): Promise<OnChainRaw>;
}

/** Narrow views over the data provider for engines that only need one thing. */
export interface PriceProvider {
  getPriceUsd(chain: ChainId, address: string): Promise<number | null>;
}
export interface LiquidityProvider {
  getLiquidityUsd(chain: ChainId, address: string): Promise<number | null>;
}

export interface WalletProvider {
  /** Native-token balance (e.g. SOL) for an address. */
  getNativeBalance(address: string): Promise<number>;
  /**
   * Verify an ownership signature over `message`. Never handles private keys.
   * Solana: base64 ed25519 signature. EVM: 0x-prefixed EIP-191 personal_sign signature.
   */
  verifyMessageSignature(address: string, message: string, signature: string): boolean | Promise<boolean>;
}

/** What a swap costs the wallet beyond the amount swapped, in the chain's native coin, as measured on-chain right now. */
export interface SwapReserve {
  /** the most needed available at the instant the swap runs (what to keep back) */
  peakNative: number;
  /** network fees (and any priority fee): the part that is simply spent */
  feesNative: number;
  /** one-off deposits (e.g. Solana's token account) that are recoverable, not spent */
  depositNative: number;
}

export interface ChainAdapter extends WalletProvider {
  readonly chain: ChainId;
  readonly nativeSymbol: string;
  readonly nativeUsdPrice: () => Promise<number>;
  /** Optional: the live on-chain cost of a swap for `owner` (and, when known, `tokenAddress`). null = could not be read. */
  estimateSwapReserve?(owner: string, tokenAddress?: string): Promise<SwapReserve | null>;
  /**
   * Optional: how much of a token `owner` holds right now, in whole tokens. 0 is a real answer (the chain says none); null means
   * it could not be read (an unreachable node must never read as "none left").
   */
  getTokenBalance?(owner: string, tokenAddress: string): Promise<number | null>;
  isValidAddress(address: string): boolean;
  explorerTxUrl(signature: string): string;
  explorerTokenUrl(address: string): string;
}

export interface QuoteRequest {
  chain: ChainId;
  side: "BUY" | "SELL";
  tokenAddress: string;
  /** USD notional for a buy; USD value of tokens being sold for a sell */
  amountUsd: number;
  /** token amount for sells (UI units) */
  tokenAmount?: number;
  slippageBps: number;
  /** priority fee / gas tip in the chain's native unit (SOL, ETH, BNB...) */
  priorityFeeNative?: number;
}

export interface SwapSimulation {
  ok: boolean;
  error?: string;
  /** true when the check could not be run or was inconclusive (a busy provider, a data hiccup): NOT evidence the token can't be sold */
  unknown?: boolean;
  unitsConsumed?: number;
}

export interface TransactionStatus {
  status: "PENDING" | "CONFIRMED" | "FAILED" | "NOT_FOUND";
  slot?: number;
  error?: string;
}

/** Aggregator / DEX access. */
export type PreflightResult = { ok: true } | { ok: false; kind: string; error: string };

export interface DexAdapter {
  readonly name: string;
  readonly kind: DataSourceKind;
  getQuote(req: QuoteRequest): Promise<SwapQuote>;
  /**
   * Returns an UNSIGNED transaction payload for the user's wallet to sign. Never signs.
   * Solana: base64 VersionedTransaction. EVM: JSON `{ chainId, approval?: {to,data}, tx: {to,data,value} }`.
   */
  buildSwapTransaction(quote: SwapQuote, userAddress: string): Promise<{ unsignedTxBase64: string }>;
  /**
   * Optional: dry-run an UNSIGNED transaction as the user's wallet would see it, before the wallet is ever opened, so a swap
   * that would fail (slippage, not enough SOL, ...) is explained here instead of as a wallet "simulation failed" popup.
   * An unreachable node must answer ok: not being able to check is not a reason to block.
   */
  preflight?(chain: ChainId, unsignedTx: string, userAddress: string): Promise<PreflightResult>;
  estimatePriceImpact(req: QuoteRequest): Promise<number>;
  getLiquidity(chain: ChainId, tokenAddress: string): Promise<number>;
  /**
   * Submit an already-signed transaction. Real adapters broadcast the bytes; the mock adapter refuses because
   * simulated trades are recorded by the PaperBroker and must never look like on-chain transactions.
   */
  executeSwap(chain: ChainId, signedTx: string): Promise<{ signature: string }>;
  simulateSwap(req: QuoteRequest): Promise<SwapSimulation>;
  getTransactionStatus(chain: ChainId, signature: string): Promise<TransactionStatus>;
  /**
   * Optional: inspect a confirmed transaction so positions use real on-chain amounts and the signer is verified.
   * Returns null when the transaction cannot be parsed.
   */
  inspectTransaction?(chain: ChainId, signature: string, owner: string, token: string): Promise<TransactionInspection | null>;
}

export interface TransactionInspection {
  /** account that paid for / sent the transaction */
  signer: string;
  /** change in the owner's balance of the token (UI units; positive = received) */
  tokenDelta: number;
  /** change in the owner's native balance (SOL/ETH/BNB, fee included); 0 when unknown */
  nativeDelta: number;
  /** the network fee the transaction paid, in the native coin (already inside nativeDelta); undefined when unknown */
  feeNative?: number;
}

export interface AiProvider {
  readonly name: string;
  /** true when output comes from an LLM; false for the deterministic rules-based summariser */
  readonly isLlm: boolean;
  analyze(input: AiInput): Promise<AiAnalysis>;
}

export interface ProviderBundle {
  mock: boolean;
  data: TokenDataProvider;
  dex: DexAdapter;
  ai: AiProvider;
  chains: Record<ChainId, ChainAdapter>;
}
