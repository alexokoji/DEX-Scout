/**
 * Key-free EVM swap routing. 0x (the previous only option) needs an API key, which made every EVM trade fail on a
 * fresh deployment. ParaSwap (Velora) and KyberSwap's aggregator are free, need no key, and cover all five EVM chains
 * here. MultiEvmDexAdapter tries them in order and falls through on any failure, so a single aggregator being down,
 * rate-limiting, or having no route for a token never blocks a trade. A ZEROX_API_KEY, if you ever set one, is simply
 * tried first. Swaps are only ever built UNSIGNED for the user's own wallet.
 */
import { encodeFunctionData, erc20Abi, getAddress } from "viem";
import { CHAINS, NATIVE_EVM } from "../../chains";
import type { ChainId, SwapQuote } from "../../types";
import { DexScreenerDataProvider } from "../dexscreener";
import { sellCheckInconclusive } from "../simFailure";
import { getJson } from "../http";
import type { DexAdapter, QuoteRequest, SwapSimulation, TransactionStatus } from "../interfaces";
import { evmOnChain, nativeUsd, tokenDecimals, ZeroXDexAdapter } from "./evmProviders";

interface RouteInput {
  chain: ChainId;
  sellToken: string;
  buyToken: string;
  sellAmount: bigint;
  sellDecimals: number;
  buyDecimals: number;
  slippageBps: number;
}
interface RouteOutput {
  buyAmount: bigint;
  networkFeeUsd: number | null;
  route: string[];
  /** aggregator-specific route data needed to build the transaction (JSON-safe; stored with the quote) */
  payload: unknown;
}
interface BuiltTx {
  to: string;
  data: string;
  value: string;
  gas?: string;
  /** contract that must be approved to pull the sell token (not needed for native) */
  spender?: string;
}
interface Aggregator {
  readonly name: string;
  route(i: RouteInput): Promise<RouteOutput>;
  build(i: RouteInput, out: RouteOutput, user: string): Promise<BuiltTx>;
}

const CLIENT = "dexscout";

class ParaswapAggregator implements Aggregator {
  readonly name = "paraswap";
  async route(i: RouteInput): Promise<RouteOutput> {
    const qs = new URLSearchParams({
      srcToken: i.sellToken, destToken: i.buyToken, amount: i.sellAmount.toString(), srcDecimals: String(i.sellDecimals), destDecimals: String(i.buyDecimals),
      side: "SELL", network: String(CHAINS[i.chain].evmChainId), version: "6.2",
    });
    const j = await getJson<{ priceRoute?: { destAmount: string; gasCostUSD?: string; tokenTransferProxy: string; bestRoute?: { swaps?: { swapExchanges?: { exchange?: string }[] }[] }[] } }>(
      `https://api.paraswap.io/prices?${qs}`, undefined, 12_000,
    );
    const p = j.priceRoute;
    if (!p) throw new Error("no route");
    const route = [...new Set((p.bestRoute ?? []).flatMap((r) => (r.swaps ?? []).flatMap((s) => (s.swapExchanges ?? []).map((x) => x.exchange ?? "?"))))];
    return { buyAmount: BigInt(p.destAmount), networkFeeUsd: p.gasCostUSD ? Number(p.gasCostUSD) : null, route, payload: p };
  }
  async build(i: RouteInput, out: RouteOutput, user: string): Promise<BuiltTx> {
    const priceRoute = out.payload as { tokenTransferProxy: string };
    const tx = await getJson<{ to: string; data: string; value: string; gas?: string; error?: string }>(
      `https://api.paraswap.io/transactions/${CHAINS[i.chain].evmChainId}?ignoreChecks=true`,
      {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ srcToken: i.sellToken, destToken: i.buyToken, srcAmount: i.sellAmount.toString(), slippage: i.slippageBps, priceRoute, userAddress: user, srcDecimals: i.sellDecimals, destDecimals: i.buyDecimals, partner: CLIENT }),
      },
      12_000,
    );
    if (!tx.to || !tx.data) throw new Error(tx.error ?? "aggregator returned no transaction");
    return { to: tx.to, data: tx.data, value: tx.value || "0", gas: tx.gas, spender: priceRoute.tokenTransferProxy };
  }
}

class KyberAggregator implements Aggregator {
  readonly name = "kyberswap";
  private headers = { "x-client-id": CLIENT, "content-type": "application/json" };
  async route(i: RouteInput): Promise<RouteOutput> {
    const qs = new URLSearchParams({ tokenIn: i.sellToken, tokenOut: i.buyToken, amountIn: i.sellAmount.toString() });
    const j = await getJson<{ data?: { routeSummary?: { amountOut: string; gasUsd?: string }; routerAddress?: string } }>(
      `https://aggregator-api.kyberswap.com/${CHAINS[i.chain].kyberSlug}/api/v1/routes?${qs}`, { headers: this.headers }, 12_000,
    );
    const r = j.data?.routeSummary;
    if (!r) throw new Error("no route");
    return { buyAmount: BigInt(r.amountOut), networkFeeUsd: r.gasUsd ? Number(r.gasUsd) : null, route: ["kyberswap"], payload: { routeSummary: r, routerAddress: j.data?.routerAddress } };
  }
  async build(i: RouteInput, out: RouteOutput, user: string): Promise<BuiltTx> {
    const p = out.payload as { routeSummary: unknown; routerAddress?: string };
    const j = await getJson<{ data?: { data: string; routerAddress: string; transactionValue?: string; gas?: string } }>(
      `https://aggregator-api.kyberswap.com/${CHAINS[i.chain].kyberSlug}/api/v1/route/build`,
      { method: "POST", headers: this.headers, body: JSON.stringify({ routeSummary: p.routeSummary, sender: user, recipient: user, slippageTolerance: i.slippageBps, source: CLIENT }) },
      12_000,
    );
    const d = j.data;
    if (!d?.data) throw new Error("aggregator returned no transaction");
    return { to: d.routerAddress, data: d.data, value: d.transactionValue || "0", gas: d.gas, spender: d.routerAddress };
  }
}

interface StoredRaw {
  aggregator: string;
  sellAmount: string;
  sellToken: string;
  buyToken: string;
  sellDecimals: number;
  buyDecimals: number;
  slippageBps: number;
  buyAmount: string;
  networkFeeUsd: number | null;
  route: string[];
  payload: unknown;
}

/** EVM DEX adapter that needs no API key: ParaSwap, then KyberSwap (and 0x first, only if a key is configured). */
export class MultiEvmDexAdapter implements DexAdapter {
  readonly name = "evm-multi-aggregator";
  readonly kind = "LIVE" as const;
  private data = new DexScreenerDataProvider({ svm: async () => { throw new Error("not an SVM adapter"); }, evm: evmOnChain });
  private zerox = new ZeroXDexAdapter(); // only used for its key-less chain helpers, and as an optional first route
  private all: Aggregator[] = [new ParaswapAggregator(), new KyberAggregator()];

  /** Only the free aggregators that actually serve this chain (a 404 per request is wasted latency). */
  private aggregatorsFor(chain: ChainId): Aggregator[] {
    const m = CHAINS[chain];
    return this.all.filter((a) => (a.name === "paraswap" ? m.paraswap : !!m.kyberSlug));
  }

  async getQuote(req: QuoteRequest): Promise<SwapQuote> {
    const errors: string[] = [];
    const aggregators = this.aggregatorsFor(req.chain);

    if (!aggregators.length && !process.env.ZEROX_API_KEY) {
      // Not a bug and not a block on scanning: these chains have no free aggregator route.
      throw new Error(`Swaps on ${CHAINS[req.chain].name} need a 0x API key (the free tier works) — add ZEROX_API_KEY. Scanning and signals on this chain still work.`);
    }

    if (process.env.ZEROX_API_KEY) {
      try {
        const q = await this.zerox.getQuote(req);
        return { ...q, raw: { ...(q.raw as object), aggregator: "0x" } };
      } catch (e) {
        errors.push(`0x: ${e instanceof Error ? e.message : "failed"}`);
      }
    }

    const snap = await this.data.getSnapshot(req.chain, req.tokenAddress);
    if (!snap) throw new Error("Token not found or no longer tradeable");
    const dec = await tokenDecimals(req.chain, req.tokenAddress);
    const nat = await nativeUsd(req.chain);
    const buying = req.side === "BUY";
    const sellAmount = buying ? BigInt(Math.floor((req.amountUsd / nat) * 1e18)) : BigInt(Math.floor((req.tokenAmount ?? req.amountUsd / snap.priceUsd) * 10 ** dec));
    const input: RouteInput = {
      chain: req.chain,
      sellToken: buying ? NATIVE_EVM : req.tokenAddress,
      buyToken: buying ? req.tokenAddress : NATIVE_EVM,
      sellAmount,
      sellDecimals: buying ? 18 : dec,
      buyDecimals: buying ? dec : 18,
      slippageBps: req.slippageBps,
    };

    for (const agg of aggregators) {
      try {
        const out = await agg.route(input);
        if (out.buyAmount <= BigInt(0)) throw new Error("zero output");
        const outputAmount = buying ? Number(out.buyAmount) / 10 ** dec : (Number(out.buyAmount) / 1e18) * nat;
        // price per token. A sell with no explicit token amount (the pre-buy "can it be sold?" dry run) sold sellAmount tokens;
        // dividing by 1 instead made every such quote look absurdly far from the market, which the sanity check below then
        // refused: every EVM token failed "sell simulation".
        const tokensSold = req.tokenAmount ?? Number(sellAmount) / 10 ** dec;
        const effective = buying ? req.amountUsd / outputAmount : outputAmount / tokensSold;
        const signedImpact = buying ? (effective / snap.priceUsd - 1) * 100 : (1 - effective / snap.priceUsd) * 100;
        // A fill far BETTER than the market is not a bargain, it's a sign something upstream is wrong (a bad native price sizes the
        // order wrongly, a wrong pool, a unit mix-up). Refuse it rather than sign it.
        if (signedImpact < -25) throw new Error(`quote is ${Math.abs(signedImpact).toFixed(0)}% away from the market price in the user's favour; refusing as it points to bad pricing data`);
        const impact = Math.max(0, signedImpact);
        // network fee: the aggregator's own gas figure for this route at the chain's current gas price, or unknown (the wallet shows the exact fee)
        const networkFeeUsd = out.networkFeeUsd ?? 0;
        const raw: StoredRaw = {
          aggregator: agg.name, sellAmount: sellAmount.toString(), sellToken: input.sellToken, buyToken: input.buyToken, sellDecimals: input.sellDecimals,
          buyDecimals: input.buyDecimals, slippageBps: req.slippageBps, buyAmount: out.buyAmount.toString(), networkFeeUsd: out.networkFeeUsd, route: out.route, payload: out.payload,
        };
        return {
          chain: req.chain,
          inputMint: input.sellToken,
          outputMint: input.buyToken,
          inputAmountUsd: req.amountUsd,
          outputAmount,
          effectivePriceUsd: effective,
          priceImpactPct: impact,
          slippageBps: req.slippageBps,
          minReceived: outputAmount * (1 - req.slippageBps / 10_000),
          networkFeeUsd,
          networkFeeKnown: out.networkFeeUsd != null,
          priorityFeeUsd: (req.priorityFeeNative ?? 0) * nat,
          platformFeeUsd: 0,
          route: out.route.length ? out.route : [agg.name],
          expiresAt: new Date(Date.now() + 45_000),
          raw,
          source: "LIVE",
        };
      } catch (e) {
        errors.push(`${agg.name}: ${e instanceof Error ? e.message : "failed"}`);
      }
    }
    throw new Error(`No swap route found on any aggregator (${errors.join("; ")})`);
  }

  async buildSwapTransaction(quote: SwapQuote, userAddress: string) {
    const raw = quote.raw as StoredRaw & { aggregator: string };
    if (raw.aggregator === "0x") return this.zerox.buildSwapTransaction(quote, userAddress);
    const agg = this.all.find((a) => a.name === raw.aggregator);
    if (!agg) throw new Error(`Unknown aggregator ${raw.aggregator}`);
    const input: RouteInput = { chain: quote.chain, sellToken: raw.sellToken, buyToken: raw.buyToken, sellAmount: BigInt(raw.sellAmount), sellDecimals: raw.sellDecimals, buyDecimals: raw.buyDecimals, slippageBps: raw.slippageBps };
    const out: RouteOutput = { buyAmount: BigInt(raw.buyAmount), networkFeeUsd: raw.networkFeeUsd, route: raw.route, payload: raw.payload };
    const tx = await agg.build(input, out, userAddress);
    const approval =
      tx.spender && raw.sellToken.toLowerCase() !== NATIVE_EVM.toLowerCase()
        ? { to: raw.sellToken, data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [getAddress(tx.spender), BigInt(raw.sellAmount)] }), value: "0x0" }
        : undefined;
    const payload = {
      chainId: CHAINS[quote.chain].evmChainId,
      approval,
      // gas deliberately omitted: aggregators return it as a decimal string and wallets require hex (they rejected it
      // outright), and the wallet's own estimate is what the user sees and approves anyway.
      tx: { to: tx.to, data: tx.data, value: "0x" + BigInt(tx.value || "0").toString(16) },
    };
    return { unsignedTxBase64: JSON.stringify(payload) };
  }

  async estimatePriceImpact(req: QuoteRequest): Promise<number> {
    return (await this.getQuote(req)).priceImpactPct;
  }

  async getLiquidity(chain: ChainId, tokenAddress: string): Promise<number> {
    return (await this.data.getSnapshot(chain, tokenAddress))?.liquidityUsd ?? 0;
  }

  async simulateSwap(req: QuoteRequest): Promise<SwapSimulation> {
    try {
      const q = await this.getQuote(req);
      return q.outputAmount > 0 ? { ok: true } : { ok: false, error: "No route / zero output" };
    } catch (e) {
      const error = e instanceof Error ? e.message : "Quote failed";
      return { ok: false, error, unknown: sellCheckInconclusive(error) };
    }
  }

  // chain-level operations need no aggregator or key — they only use the failover RPC
  executeSwap(chain: ChainId, signedTx: string) {
    return this.zerox.executeSwap(chain, signedTx);
  }
  getTransactionStatus(chain: ChainId, hash: string): Promise<TransactionStatus> {
    return this.zerox.getTransactionStatus(chain, hash);
  }
  inspectTransaction(chain: ChainId, hash: string, owner: string, token: string) {
    return this.zerox.inspectTransaction(chain, hash, owner, token);
  }
}
