/**
 * Real Solana providers: Solana JSON-RPC and the Jupiter aggregator. Market data comes from the shared
 * DexScreener provider. Exercised only when MOCK_PROVIDER is not "true". Endpoints/keys come from env.
 */
import { Connection, PublicKey, VersionedTransaction } from "@solana/web3.js";
import nacl from "tweetnacl";
import { FEES } from "../../config";
import { CHAINS } from "../../chains";
import type { ChainId, OnChainRaw, SwapQuote, TokenSnapshot } from "../../types";
import { env } from "../../../lib/env";
import { DexScreenerDataProvider } from "../dexscreener";
import { getJson, withTimeout } from "../http";
import type { ChainAdapter, DexAdapter, QuoteRequest, SwapSimulation, TransactionStatus } from "../interfaces";

const SOL_MINT = CHAINS.solana.wrappedNative;
const dexData = () => new DexScreenerDataProvider({ svm: solanaOnChain, evm: async () => { throw new Error("not an EVM adapter"); } });

let solPriceCache: { at: number; usd: number } | null = null;
export async function solUsd(): Promise<number> {
  if (solPriceCache && Date.now() - solPriceCache.at < 60_000) return solPriceCache.usd;
  try {
    const j = await getJson<{ pairs?: { priceUsd?: string }[] }>(`${env().MARKET_DATA_URL}/latest/dex/tokens/${SOL_MINT}`);
    const usd = Number(j.pairs?.[0]?.priceUsd);
    if (usd > 0) solPriceCache = { at: Date.now(), usd };
  } catch {
    /* fall through to stale/default */
  }
  return solPriceCache?.usd ?? CHAINS.solana.mockNativeUsd;
}

let conn: Connection | null = null;
export function connection(): Connection {
  return (conn ??= new Connection(env().SOLANA_RPC_URL, { commitment: "confirmed", wsEndpoint: env().SOLANA_WS_URL }));
}

export class SolanaChainAdapter implements ChainAdapter {
  readonly chain = "solana" as const;
  readonly nativeSymbol = "SOL";
  nativeUsdPrice = () => solUsd();

  isValidAddress(address: string) {
    try {
      new PublicKey(address);
      return address.length >= 32 && address.length <= 44;
    } catch {
      return false;
    }
  }
  explorerTxUrl(signature: string) {
    return `${CHAINS.solana.explorer}/tx/${signature}`;
  }
  explorerTokenUrl(address: string) {
    return `${CHAINS.solana.explorer}/token/${address}`;
  }
  async getNativeBalance(address: string): Promise<number> {
    return (await connection().getBalance(new PublicKey(address))) / 1e9;
  }
  verifyMessageSignature(address: string, message: string, signatureBase64: string): boolean {
    try {
      return nacl.sign.detached.verify(new TextEncoder().encode(message), Buffer.from(signatureBase64, "base64"), new PublicKey(address).toBytes());
    } catch {
      return false;
    }
  }
}

// Unlike `rpcCall` (used by the EVM adapter), `@solana/web3.js`'s `Connection` methods carry no
// application-level timeout of their own — a slow response from the default public RPC (rate-limited,
// no SLA) can otherwise hang far longer than every other call in the analysis pipeline combined, with
// nothing to cut it off before it eats the whole serverless request budget. `withTimeout` (below) bounds
// both calls explicitly, at the same 6s used for the EVM adapter's own on-chain RPC calls (see
// EVM_RPC_TIMEOUT_MS in evmProviders.ts) so neither chain family's worst case dominates a token's overall
// per-token deadline (services/analysis.ts).
const SOLANA_RPC_TIMEOUT_MS = 6_000;

/** Solana raw facts: mint/freeze authority, top-holder concentration, sell-side heuristics. */
export async function solanaOnChain(_chain: ChainId, address: string, snapshot: TokenSnapshot): Promise<OnChainRaw> {
  const c = connection();
  const mint = new PublicKey(address);
  const anomalies: string[] = [];
  let mintRevoked = false;
  let freezeRevoked = false;
  let topHolderPct = 0;
  let top10 = 0;
  let dataAvailable = true;
  try {
    const info = await withTimeout(c.getParsedAccountInfo(mint), SOLANA_RPC_TIMEOUT_MS);
    const parsed = (info.value?.data as { parsed?: { info?: { mintAuthority: string | null; freezeAuthority: string | null } } })?.parsed?.info;
    mintRevoked = parsed ? parsed.mintAuthority === null : false;
    freezeRevoked = parsed ? parsed.freezeAuthority === null : false;
    const [largest, supply] = await withTimeout(Promise.all([c.getTokenLargestAccounts(mint), c.getTokenSupply(mint)]), SOLANA_RPC_TIMEOUT_MS);
    const total = Number(supply.value.amount) || 1;
    const amounts = largest.value.map((a) => (Number(a.amount) / total) * 100);
    // The largest account is frequently the liquidity pool vault; report it but callers should treat it with care.
    topHolderPct = amounts[0] ?? 0;
    top10 = amounts.slice(0, 10).reduce((a, b) => a + b, 0);
  } catch {
    dataAvailable = false; // unknown, not "authority active" — assessSafety scores this separately
  }
  const buyShare = snapshot.buys1h / Math.max(1, snapshot.buys1h + snapshot.sells1h);
  return {
    mintAuthorityRevoked: mintRevoked,
    freezeAuthorityRevoked: freezeRevoked,
    verified: false,
    topHolderPct,
    top10HolderPct: top10,
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
    dataAvailable,
  };
}

interface JupQuote {
  outAmount: string;
  priceImpactPct: string;
  routePlan?: { swapInfo?: { label?: string } }[];
  [k: string]: unknown;
}

/** Jupiter aggregator adapter. It only ever builds UNSIGNED transactions; signing happens in the user's wallet. */
export class JupiterDexAdapter implements DexAdapter {
  readonly name = "jupiter";
  readonly kind = "LIVE" as const;
  private data = dexData();

  private headers(): HeadersInit {
    const k = env().DEX_PROVIDER_API_KEY;
    return k ? { "x-api-key": k, "content-type": "application/json" } : { "content-type": "application/json" };
  }

  async getQuote(req: QuoteRequest): Promise<SwapQuote> {
    const snap = await this.data.getSnapshot(req.chain, req.tokenAddress);
    if (!snap) throw new Error("Token not found or no longer tradeable");
    const sol = await solUsd();
    const mint = new PublicKey(req.tokenAddress);
    const decimals = (await connection().getTokenSupply(mint)).value.decimals;
    const inputMint = req.side === "BUY" ? SOL_MINT : req.tokenAddress;
    const outputMint = req.side === "BUY" ? req.tokenAddress : SOL_MINT;
    const inAmount =
      req.side === "BUY"
        ? Math.floor((req.amountUsd / sol) * 1e9)
        : Math.floor((req.tokenAmount ?? req.amountUsd / snap.priceUsd) * 10 ** decimals);
    const q = await getJson<JupQuote>(
      `${env().DEX_PROVIDER_URL}/quote?inputMint=${inputMint}&outputMint=${outputMint}&amount=${inAmount}&slippageBps=${req.slippageBps}`,
      { headers: this.headers() },
    );
    const out = Number(q.outAmount);
    const outputAmount = req.side === "BUY" ? out / 10 ** decimals : (out / 1e9) * sol;
    const priorityFee = req.priorityFeeNative ?? FEES.defaultPriorityFeeSol;
    return {
      chain: "solana",
      inputMint,
      outputMint,
      inputAmountUsd: req.amountUsd,
      outputAmount,
      effectivePriceUsd: req.side === "BUY" ? req.amountUsd / outputAmount : outputAmount / (req.tokenAmount ?? 1),
      priceImpactPct: Math.abs(Number(q.priceImpactPct)) * 100,
      slippageBps: req.slippageBps,
      minReceived: outputAmount * (1 - req.slippageBps / 10_000),
      networkFeeUsd: FEES.networkFeeSol * sol,
      priorityFeeUsd: priorityFee * sol,
      platformFeeUsd: 0,
      route: (q.routePlan ?? []).map((r) => r.swapInfo?.label ?? "?"),
      expiresAt: new Date(Date.now() + 20_000),
      raw: q,
      source: "LIVE",
    };
  }

  async buildSwapTransaction(quote: SwapQuote, userAddress: string) {
    const j = await getJson<{ swapTransaction: string }>(`${env().DEX_PROVIDER_URL}/swap`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({
        quoteResponse: quote.raw,
        userPublicKey: userAddress,
        dynamicComputeUnitLimit: true,
        prioritizationFeeLamports: Math.floor((quote.priorityFeeUsd / (await solUsd())) * 1e9),
      }),
    });
    return { unsignedTxBase64: j.swapTransaction };
  }

  async estimatePriceImpact(req: QuoteRequest): Promise<number> {
    return (await this.getQuote(req)).priceImpactPct;
  }

  async getLiquidity(chain: ChainId, tokenAddress: string): Promise<number> {
    return (await this.data.getSnapshot(chain, tokenAddress))?.liquidityUsd ?? 0;
  }

  /** Broadcasts a transaction that the user's wallet already signed. */
  async executeSwap(_chain: ChainId, signedTxBase64: string) {
    const tx = VersionedTransaction.deserialize(Buffer.from(signedTxBase64, "base64"));
    const signature = await connection().sendRawTransaction(tx.serialize(), { skipPreflight: false, maxRetries: 3 });
    return { signature };
  }

  async simulateSwap(req: QuoteRequest): Promise<SwapSimulation> {
    try {
      const q = await this.getQuote(req);
      return q.outputAmount > 0 ? { ok: true } : { ok: false, error: "No route / zero output" };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : "Quote failed" };
    }
  }

  async inspectTransaction(_chain: ChainId, signature: string, owner: string, mint: string) {
    const tx = await connection().getParsedTransaction(signature, { maxSupportedTransactionVersion: 0, commitment: "confirmed" });
    if (!tx?.meta) return null;
    const keys = tx.transaction.message.accountKeys;
    const signer = keys[0]?.pubkey.toBase58() ?? "";
    const bal = (arr: typeof tx.meta.postTokenBalances) =>
      (arr ?? []).filter((b) => b.owner === owner && b.mint === mint).reduce((s, b) => s + (b.uiTokenAmount.uiAmount ?? 0), 0);
    const idx = keys.findIndex((k) => k.pubkey.toBase58() === owner);
    const nativeDelta = idx >= 0 ? (tx.meta.postBalances[idx] - tx.meta.preBalances[idx]) / 1e9 : 0;
    return { signer, tokenDelta: bal(tx.meta.postTokenBalances) - bal(tx.meta.preTokenBalances), nativeDelta };
  }

  async getTransactionStatus(_chain: ChainId, signature: string): Promise<TransactionStatus> {
    const res = await connection().getSignatureStatuses([signature], { searchTransactionHistory: true });
    const s = res.value[0];
    if (!s) return { status: "NOT_FOUND" };
    if (s.err) return { status: "FAILED", error: JSON.stringify(s.err), slot: s.slot };
    if (s.confirmationStatus === "confirmed" || s.confirmationStatus === "finalized") return { status: "CONFIRMED", slot: s.slot };
    return { status: "PENDING", slot: s.slot };
  }
}
