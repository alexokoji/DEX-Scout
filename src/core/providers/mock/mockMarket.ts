import { CHAINS } from "../../chains";
import type { Candle, ChainId, OnChainRaw, SwapQuote, Timeframe, TokenSnapshot } from "../../types";
import type { ChainAdapter, DexAdapter, QuoteRequest, SwapSimulation, TokenDataProvider, TransactionStatus } from "../interfaces";
import { candlesAt, findTokenByAddress, liveTokenIndices, onChainAt, snapshotAt, toMinute, tokenSpec } from "./world";
import { constantProductImpactPct, quoteFromImpact } from "../../trading/quoteMath";

export class MockTokenDataProvider implements TokenDataProvider {
  readonly name = "mock-market";
  readonly kind = "MOCK" as const;

  async discover(chain: ChainId): Promise<TokenSnapshot[]> {
    const now = toMinute(Date.now());
    return liveTokenIndices(now, chain).map((i) => snapshotAt(tokenSpec(i, chain), now));
  }

  async getSnapshot(chain: ChainId, address: string): Promise<TokenSnapshot | null> {
    const now = toMinute(Date.now());
    const spec = findTokenByAddress(address, now, chain);
    return spec ? snapshotAt(spec, now) : null;
  }

  async getCandles(chain: ChainId, address: string, timeframe: Timeframe, limit: number): Promise<Candle[]> {
    const now = toMinute(Date.now());
    const spec = findTokenByAddress(address, now, chain);
    return spec ? candlesAt(spec, now, timeframe, limit) : [];
  }

  async getOnChain(chain: ChainId, address: string, _snapshot: TokenSnapshot): Promise<OnChainRaw> {
    const now = toMinute(Date.now());
    const spec = findTokenByAddress(address, now, chain);
    if (!spec) throw new Error("Unknown token");
    return onChainAt(spec, now);
  }
}

/**
 * Mock DEX for every chain. Quotes are priced from the simulated pool, but it can never build, sign or
 * broadcast anything real — there's no actual chain behind mock data. LIVE trading is fundamentally
 * untestable in mock mode for that reason; this is an honest limitation, not a gap to paper over.
 */
export class MockDexAdapter implements DexAdapter {
  readonly name = "mock-dex";
  readonly kind = "MOCK" as const;
  private data = new MockTokenDataProvider();

  async getQuote(req: QuoteRequest): Promise<SwapQuote> {
    const snap = await this.data.getSnapshot(req.chain, req.tokenAddress);
    if (!snap) throw new Error("Token not found or no longer tradeable");
    if (snap.liquidityUsd < 500) throw new Error("Liquidity unavailable for this token");
    const impact = constantProductImpactPct(req.amountUsd, snap.liquidityUsd);
    return quoteFromImpact({
      chain: req.chain,
      side: req.side,
      tokenAddress: req.tokenAddress,
      priceUsd: snap.priceUsd,
      amountUsd: req.amountUsd,
      impactPct: impact,
      slippageBps: req.slippageBps,
      priorityFeeNative: req.priorityFeeNative ?? 0,
      route: [snap.dex, `${snap.symbol}/${CHAINS[req.chain].nativeSymbol}`],
      source: "MOCK",
    });
  }

  async buildSwapTransaction(): Promise<{ unsignedTxBase64: string }> {
    throw new Error("Mock provider cannot build on-chain transactions. Disable MOCK_PROVIDER and configure a real RPC/aggregator to trade LIVE.");
  }

  async estimatePriceImpact(req: QuoteRequest): Promise<number> {
    const snap = await this.data.getSnapshot(req.chain, req.tokenAddress);
    if (!snap) return 100;
    return constantProductImpactPct(req.amountUsd, snap.liquidityUsd);
  }

  async getLiquidity(chain: ChainId, tokenAddress: string): Promise<number> {
    return (await this.data.getSnapshot(chain, tokenAddress))?.liquidityUsd ?? 0;
  }

  async executeSwap(): Promise<{ signature: string }> {
    throw new Error("Mock provider never broadcasts transactions.");
  }

  async simulateSwap(req: QuoteRequest): Promise<SwapSimulation> {
    const now = toMinute(Date.now());
    const spec = findTokenByAddress(req.tokenAddress, now, req.chain);
    if (!spec) return { ok: false, error: "Token not found" };
    const raw = onChainAt(spec, now);
    if (!raw.poolActive) return { ok: false, error: "Pool is no longer active" };
    if (req.side === "SELL" && !raw.sellSimulationOk) return { ok: false, error: "Sell simulation failed" };
    return { ok: true };
  }

  async getTransactionStatus(): Promise<TransactionStatus> {
    return { status: "NOT_FOUND" };
  }
}

export class MockChainAdapter implements ChainAdapter {
  readonly nativeSymbol: string;
  constructor(readonly chain: ChainId) {
    this.nativeSymbol = CHAINS[chain].nativeSymbol;
  }
  nativeUsdPrice = async () => CHAINS[this.chain].mockNativeUsd;

  isValidAddress(address: string) {
    return CHAINS[this.chain].family === "evm" ? /^0x[0-9a-fA-F]{40}$/.test(address) : /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(address);
  }
  explorerTxUrl(signature: string) {
    return `${CHAINS[this.chain].explorer}/tx/${signature}`;
  }
  explorerTokenUrl(address: string) {
    return `${CHAINS[this.chain].explorer}/token/${address}`;
  }
  async getNativeBalance(address: string): Promise<number> {
    // deterministic pseudo-balance so the wallet page is populated in mock mode
    let h = 0;
    for (const c of address) h = (h * 31 + c.charCodeAt(0)) >>> 0;
    return Math.round((1 + (h % 900) / 100) * 1000) / 1000;
  }
  verifyMessageSignature(): boolean {
    return false; // mock mode links wallets without signature verification (see /api/wallet)
  }
}