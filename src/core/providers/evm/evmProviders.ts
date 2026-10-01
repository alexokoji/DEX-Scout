/**
 * EVM chains (Ethereum, Base, BNB Chain, Arbitrum, Polygon): JSON-RPC chain adapter, on-chain safety heuristics and a
 * 0x-aggregator swap adapter. Like the Solana providers these run only when MOCK_PROVIDER is not "true" and have
 * not been exercised against mainnet in this repository. Swaps are only ever built UNSIGNED for the user's wallet.
 */
import { encodeFunctionData, erc20Abi, getAddress, isAddress, verifyMessage, type Hex } from "viem";
import { CHAINS, NATIVE_EVM, normalizeAddress } from "../../chains";
import type { ChainId, OnChainRaw, SwapQuote, TokenSnapshot } from "../../types";
import { env } from "../../../lib/env";
import { DexScreenerDataProvider } from "../dexscreener";
import { getJson, rpcCall } from "../http";
import type { ChainAdapter, DexAdapter, QuoteRequest, SwapSimulation, TransactionStatus } from "../interfaces";

export function rpcUrl(chain: ChainId): string {
  const meta = CHAINS[chain];
  return process.env[meta.rpcEnv] || meta.defaultRpc;
}

const priceCache = new Map<ChainId, { at: number; usd: number }>();
export async function nativeUsd(chain: ChainId): Promise<number> {
  const hit = priceCache.get(chain);
  if (hit && Date.now() - hit.at < 60_000) return hit.usd;
  const meta = CHAINS[chain];
  try {
    const j = await getJson<{ pairs?: { chainId: string; priceUsd?: string; liquidity?: { usd?: number } }[] }>(`${env().MARKET_DATA_URL}/latest/dex/tokens/${meta.wrappedNative}`);
    const best = (j.pairs ?? []).filter((p) => p.chainId === meta.dexScreenerId).sort((a, b) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0))[0];
    const usd = Number(best?.priceUsd);
    if (usd > 0) priceCache.set(chain, { at: Date.now(), usd });
  } catch {
    /* use stale/default */
  }
  return priceCache.get(chain)?.usd ?? meta.mockNativeUsd;
}

export class EvmChainAdapter implements ChainAdapter {
  readonly nativeSymbol: string;
  constructor(readonly chain: ChainId) {
    this.nativeSymbol = CHAINS[chain].nativeSymbol;
  }
  nativeUsdPrice = () => nativeUsd(this.chain);

  isValidAddress(address: string) {
    return isAddress(address, { strict: false });
  }
  explorerTxUrl(hash: string) {
    return `${CHAINS[this.chain].explorer}/tx/${hash}`;
  }
  explorerTokenUrl(address: string) {
    return `${CHAINS[this.chain].explorer}/token/${address}`;
  }
  async getNativeBalance(address: string): Promise<number> {
    const hex = await rpcCall<string>(rpcUrl(this.chain), "eth_getBalance", [address, "latest"]);
    return Number(BigInt(hex)) / 1e18;
  }
  async verifyMessageSignature(address: string, message: string, signature: string): Promise<boolean> {
    try {
      return await verifyMessage({ address: getAddress(address), message, signature: signature as Hex });
    } catch {
      return false;
    }
  }
}

const ZERO = /^0x0*$/;

// Tighter than getJson's 10s default: this runs twice, sequentially, inside the analysis pipeline's
// overall per-token deadline (see PER_TOKEN_DEADLINE_MS in services/analysis.ts) -- two calls at the
// default would alone cost up to 20s on a slow/congested public RPC, leaving the token no room for its
// snapshot lookup or candle fetch before getting cut off regardless of whether the RPC call itself ever
// would have succeeded.
const EVM_RPC_TIMEOUT_MS = 6_000;

/** EVM raw facts: renounced ownership, sell-side heuristics. Holder concentration needs an indexer (Birdeye/Covalent). */
export async function evmOnChain(chain: ChainId, address: string, snapshot: TokenSnapshot): Promise<OnChainRaw> {
  const anomalies: string[] = [];
  let ownerRenounced = false;
  try {
    // owner() -> address; a revert means the contract has no owner concept (treated as renounced)
    const res = await rpcCall<string>(rpcUrl(chain), "eth_call", [{ to: address, data: "0x8da5cb5b" }, "latest"], EVM_RPC_TIMEOUT_MS).catch(() => "0x");
    const slot = res.length >= 66 ? "0x" + res.slice(26) : "0x";
    ownerRenounced = ZERO.test(slot) || slot === "0x" || slot.toLowerCase() === "0x000000000000000000000000000000000000dead";
    const code = await rpcCall<string>(rpcUrl(chain), "eth_getCode", [address, "latest"], EVM_RPC_TIMEOUT_MS);
    if (!code || code === "0x") anomalies.push("Address has no contract code");
  } catch {
    anomalies.push("On-chain ownership data unavailable from RPC");
  }
  const buyShare = snapshot.buys1h / Math.max(1, snapshot.buys1h + snapshot.sells1h);
  return {
    mintAuthorityRevoked: ownerRenounced,
    freezeAuthorityRevoked: ownerRenounced, // blacklist/pause functions are owner-gated on most tokens
    verified: false,
    topHolderPct: 0,
    top10HolderPct: 0,
    sellSimulationOk: snapshot.sells1h > 0 || snapshot.buys1h < 20,
    metadataAnomalies: anomalies,
    largeBuys1h: 0,
    largeSells1h: 0,
    largeBuyUsd1h: snapshot.volume1h * 0.2 * buyShare,
    largeSellUsd1h: snapshot.volume1h * 0.2 * (1 - buyShare),
    newHolders1h: 0,
    liquidityAddedUsd1h: 0,
    liquidityRemovedUsd1h: 0,
    suspiciousTxRatio: 0,
    poolActive: snapshot.liquidityUsd > 0,
  };
}

const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const decimalsCache = new Map<string, number>();
async function tokenDecimals(chain: ChainId, token: string): Promise<number> {
  const k = `${chain}:${token}`;
  const hit = decimalsCache.get(k);
  if (hit !== undefined) return hit;
  const res = await rpcCall<string>(rpcUrl(chain), "eth_call", [{ to: token, data: "0x313ce567" }, "latest"]);
  const d = Number(BigInt(res));
  decimalsCache.set(k, d);
  return d;
}

interface ZeroXPrice {
  buyAmount: string;
  minBuyAmount?: string;
  sellAmount: string;
  totalNetworkFee?: string;
  route?: { fills?: { source?: string }[] };
  issues?: { allowance?: { spender: string } | null };
  transaction?: { to: string; data: string; value: string; gas?: string };
}

/** 0x Swap API adapter (allowance-holder flow). Requires ZEROX_API_KEY. */
export class ZeroXDexAdapter implements DexAdapter {
  readonly name = "0x";
  readonly kind = "LIVE" as const;
  private data = new DexScreenerDataProvider({ svm: async () => { throw new Error("not an SVM adapter"); }, evm: evmOnChain });

  private headers(): HeadersInit {
    const key = process.env.ZEROX_API_KEY;
    if (!key) throw new Error("ZEROX_API_KEY is not configured");
    return { "0x-api-key": key, "0x-version": "v2" };
  }

  private async fetch0x(kind: "price" | "quote", chain: ChainId, params: Record<string, string>): Promise<ZeroXPrice> {
    const qs = new URLSearchParams({ chainId: String(CHAINS[chain].evmChainId), ...params }).toString();
    return getJson<ZeroXPrice>(`https://api.0x.org/swap/allowance-holder/${kind}?${qs}`, { headers: this.headers() }, 15_000);
  }

  private async amounts(req: QuoteRequest, snapPrice: number) {
    const dec = await tokenDecimals(req.chain, req.tokenAddress);
    const nat = await nativeUsd(req.chain);
    const sellAmount = req.side === "BUY"
      ? BigInt(Math.floor((req.amountUsd / nat) * 1e18))
      : BigInt(Math.floor((req.tokenAmount ?? req.amountUsd / snapPrice) * 10 ** dec));
    return { dec, nat, sellAmount };
  }

  async getQuote(req: QuoteRequest): Promise<SwapQuote> {
    const snap = await this.data.getSnapshot(req.chain, req.tokenAddress);
    if (!snap) throw new Error("Token not found or no longer tradeable");
    const { dec, nat, sellAmount } = await this.amounts(req, snap.priceUsd);
    const sellToken = req.side === "BUY" ? NATIVE_EVM : req.tokenAddress;
    const buyToken = req.side === "BUY" ? req.tokenAddress : NATIVE_EVM;
    const q = await this.fetch0x("price", req.chain, { sellToken, buyToken, sellAmount: sellAmount.toString(), slippageBps: String(req.slippageBps) });
    const out = Number(q.buyAmount);
    const outputAmount = req.side === "BUY" ? out / 10 ** dec : (out / 1e18) * nat;
    const effective = req.side === "BUY" ? req.amountUsd / outputAmount : outputAmount / (req.tokenAmount ?? 1);
    const impact = Math.max(0, req.side === "BUY" ? (effective / snap.priceUsd - 1) * 100 : (1 - effective / snap.priceUsd) * 100);
    const networkFeeUsd = (Number(q.totalNetworkFee ?? 0) / 1e18) * nat || CHAINS[req.chain].typicalFeeUsd;
    return {
      chain: req.chain,
      inputMint: sellToken,
      outputMint: buyToken,
      inputAmountUsd: req.amountUsd,
      outputAmount,
      effectivePriceUsd: effective,
      priceImpactPct: impact,
      slippageBps: req.slippageBps,
      minReceived: outputAmount * (1 - req.slippageBps / 10_000),
      networkFeeUsd,
      priorityFeeUsd: (req.priorityFeeNative ?? 0) * nat,
      platformFeeUsd: 0,
      route: [...new Set((q.route?.fills ?? []).map((f) => f.source ?? "?"))],
      expiresAt: new Date(Date.now() + 15_000),
      raw: { sellAmount: sellAmount.toString(), sellToken, buyToken, decimals: dec },
      source: "LIVE",
    };
  }

  async buildSwapTransaction(quote: SwapQuote, userAddress: string) {
    const raw = quote.raw as { sellAmount: string; sellToken: string; buyToken: string };
    const q = await this.fetch0x("quote", quote.chain, { sellToken: raw.sellToken, buyToken: raw.buyToken, sellAmount: raw.sellAmount, taker: userAddress, slippageBps: String(quote.slippageBps) });
    if (!q.transaction) throw new Error("Aggregator returned no transaction");
    const spender = q.issues?.allowance?.spender;
    const approval = spender && raw.sellToken.toLowerCase() !== NATIVE_EVM.toLowerCase()
      ? { to: raw.sellToken, data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [getAddress(spender), BigInt(raw.sellAmount)] }), value: "0x0" }
      : undefined;
    const payload = {
      chainId: CHAINS[quote.chain].evmChainId,
      approval,
      tx: { to: q.transaction.to, data: q.transaction.data, value: "0x" + BigInt(q.transaction.value || "0").toString(16), gas: q.transaction.gas },
    };
    return { unsignedTxBase64: JSON.stringify(payload) };
  }

  async estimatePriceImpact(req: QuoteRequest): Promise<number> {
    return (await this.getQuote(req)).priceImpactPct;
  }

  async getLiquidity(chain: ChainId, tokenAddress: string): Promise<number> {
    return (await this.data.getSnapshot(chain, tokenAddress))?.liquidityUsd ?? 0;
  }

  async executeSwap(chain: ChainId, signedTx: string) {
    const hash = await rpcCall<string>(rpcUrl(chain), "eth_sendRawTransaction", [signedTx]);
    return { signature: hash };
  }

  async simulateSwap(req: QuoteRequest): Promise<SwapSimulation> {
    try {
      const q = await this.getQuote(req);
      return q.outputAmount > 0 ? { ok: true } : { ok: false, error: "No route / zero output" };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : "Quote failed" };
    }
  }

  async getTransactionStatus(chain: ChainId, hash: string): Promise<TransactionStatus> {
    const r = await rpcCall<{ status: string; blockNumber: string } | null>(rpcUrl(chain), "eth_getTransactionReceipt", [hash]);
    if (!r) {
      const t = await rpcCall<unknown>(rpcUrl(chain), "eth_getTransactionByHash", [hash]).catch(() => null);
      return { status: t ? "PENDING" : "NOT_FOUND" };
    }
    const slot = Number(BigInt(r.blockNumber));
    return r.status === "0x1" ? { status: "CONFIRMED", slot } : { status: "FAILED", slot, error: "Transaction reverted" };
  }

  async inspectTransaction(chain: ChainId, hash: string, owner: string, token: string) {
    const r = await rpcCall<{ from: string; logs: { address: string; topics: string[]; data: string }[] } | null>(rpcUrl(chain), "eth_getTransactionReceipt", [hash]);
    if (!r) return null;
    const dec = await tokenDecimals(chain, token).catch(() => 18);
    const me = normalizeAddress(chain, owner);
    const pad = (a: string) => "0x" + a.toLowerCase().replace("0x", "").padStart(64, "0");
    let delta = BigInt(0);
    for (const l of r.logs) {
      if (l.address.toLowerCase() !== token.toLowerCase() || l.topics[0] !== TRANSFER_TOPIC || l.topics.length < 3) continue;
      const amt = BigInt(l.data);
      if (l.topics[2].toLowerCase() === pad(me)) delta += amt;
      if (l.topics[1].toLowerCase() === pad(me)) delta -= amt;
    }
    // native balance deltas need archive state; report 0 (unknown) so callers fall back to the quoted amounts
    return { signer: normalizeAddress(chain, r.from), tokenDelta: Number(delta) / 10 ** dec, nativeDelta: 0 };
  }
}
