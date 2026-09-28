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

export interface ChainAdapter extends WalletProvider {
  readonly chain: ChainId;
  readonly nativeSymbol: string;
  readonly nativeUsdPrice: () => Promise<number>;
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
  unitsConsumed?: number;
}

export interface TransactionStatus {
  status: "PENDING" | "CONFIRMED" | "FAILED" | "NOT_FOUND";
  slot?: number;
  error?: string;
}

/** Aggregator / DEX access. */
export interface DexAdapter {
  readonly name: string;
  readonly kind: DataSourceKind;
  getQuote(req: QuoteRequest): Promise<SwapQuote>;
  /**
   * Returns an UNSIGNED transaction payload for the user's wallet to sign. Never signs.
   * Solana: base64 VersionedTransaction. EVM: JSON `{ chainId, approval?: {to,data}, tx: {to,data,value} }`.
   */
  buildSwapTransaction(quote: SwapQuote, userAddress: string): Promise<{ unsignedTxBase64: string }>;
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
