import { CHAIN_IDS, CHAINS } from "../chains";
import { env } from "../../lib/env";
import { AnthropicAiProvider } from "../ai/anthropicProvider";
import type { ChainId, SwapQuote } from "../types";
import { DexScreenerDataProvider } from "./dexscreener";
import { MultiEvmDexAdapter } from "./evm/freeAggregators";
import { EvmChainAdapter, evmOnChain } from "./evm/evmProviders";
import type { ChainAdapter, DexAdapter, PreflightResult, ProviderBundle, QuoteRequest } from "./interfaces";
import { MockChainAdapter, MockDexAdapter, MockTokenDataProvider } from "./mock/mockMarket";
import { RulesAiProvider } from "./mock/mockProviders";
import { JupiterDexAdapter, SolanaChainAdapter, solanaOnChain } from "./solana/solanaProviders";

/** Dispatches every DexAdapter call to the adapter for the chain's family (Solana: Jupiter, EVM: 0x). */
class RoutingDexAdapter implements DexAdapter {
  readonly name = "multi-chain-router";
  readonly kind = "LIVE" as const;
  constructor(private svm: DexAdapter, private evm: DexAdapter) {}
  private pick(chain: ChainId) {
    return CHAINS[chain].family === "evm" ? this.evm : this.svm;
  }
  getQuote(req: QuoteRequest) {
    return this.pick(req.chain).getQuote(req);
  }
  buildSwapTransaction(quote: SwapQuote, userAddress: string) {
    return this.pick(quote.chain).buildSwapTransaction(quote, userAddress);
  }
  preflight(chain: ChainId, unsignedTx: string, userAddress: string): Promise<PreflightResult> {
    const a = this.pick(chain);
    return a.preflight ? a.preflight(chain, unsignedTx, userAddress) : Promise.resolve({ ok: true });
  }
  estimatePriceImpact(req: QuoteRequest) {
    return this.pick(req.chain).estimatePriceImpact(req);
  }
  getLiquidity(chain: ChainId, token: string) {
    return this.pick(chain).getLiquidity(chain, token);
  }
  executeSwap(chain: ChainId, signed: string) {
    return this.pick(chain).executeSwap(chain, signed);
  }
  simulateSwap(req: QuoteRequest) {
    return this.pick(req.chain).simulateSwap(req);
  }
  getTransactionStatus(chain: ChainId, sig: string) {
    return this.pick(chain).getTransactionStatus(chain, sig);
  }
  inspectTransaction(chain: ChainId, sig: string, owner: string, token: string) {
    const a = this.pick(chain);
    return a.inspectTransaction ? a.inspectTransaction(chain, sig, owner, token) : Promise.resolve(null);
  }
}

let bundle: ProviderBundle | null = null;

/**
 * Single place that decides which implementations back each abstraction.
 * Adding a chain = add it to core/chains.ts (+ a family adapter if it is not SVM/EVM) - nothing else changes.
 */
export function providers(): ProviderBundle {
  if (bundle) return bundle;
  const e = env();
  const chains = Object.fromEntries(
    CHAIN_IDS.map((id): [ChainId, ChainAdapter] => [
      id,
      e.MOCK_PROVIDER ? new MockChainAdapter(id) : CHAINS[id].family === "evm" ? new EvmChainAdapter(id) : new SolanaChainAdapter(),
    ]),
  ) as Record<ChainId, ChainAdapter>;
  const ai = e.AI_API_KEY ? new AnthropicAiProvider(e.AI_API_KEY, e.AI_MODEL) : new RulesAiProvider();
  bundle = e.MOCK_PROVIDER
    ? { mock: true, data: new MockTokenDataProvider(), dex: new MockDexAdapter(), ai, chains }
    : {
        mock: false,
        data: new DexScreenerDataProvider({ svm: solanaOnChain, evm: evmOnChain }),
        dex: new RoutingDexAdapter(new JupiterDexAdapter(), new MultiEvmDexAdapter()),
        ai,
        chains,
      };
  return bundle;
}

export function dataSourceKind() {
  return providers().mock ? ("MOCK" as const) : ("LIVE" as const);
}