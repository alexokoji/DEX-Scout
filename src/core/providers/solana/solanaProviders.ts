/**
 * Real Solana providers: Solana JSON-RPC and the Jupiter aggregator. Market data comes from the shared
 * DexScreener provider. Exercised only when MOCK_PROVIDER is not "true". Endpoints/keys come from env.
 */
import { Connection, PublicKey, SystemProgram, TransactionMessage, VersionedTransaction } from "@solana/web3.js";
import nacl from "tweetnacl";
import { CHAINS, rpcCandidates } from "../../chains";
import { nativeUsdFromPairs, type DsNativePair } from "../evm/nativePrice";
import { capMicroLamportsPerCu, priorityLamports, priorityMicroLamportsPerCu, type FeeConnection, type SolanaCosts } from "./fees";
import type { ChainId, OnChainRaw, SwapQuote, TokenSnapshot } from "../../types";
import { env } from "../../../lib/env";
import { DexScreenerDataProvider } from "../dexscreener";
import { getJson, withTimeout } from "../http";
import type { ChainAdapter, DexAdapter, PreflightResult, QuoteRequest, SwapSimulation, TransactionStatus } from "../interfaces";
import { explainSolanaSimulation } from "./errors";
import { sellRaw } from "../../trading/sellAmount";
import { ACCOUNT_SIZE, associatedTokenAddress, depositChange, TOKEN_PROGRAM } from "./tokenAccounts";
import { looksLikeHoneypotFlow } from "../../analysis/honeypot";
import { fetchTrustFacts } from "../trust";
import { sellCheckInconclusive } from "../simFailure";

const SOL_MINT = CHAINS.solana.wrappedNative;
const dexData = () => new DexScreenerDataProvider({ svm: solanaOnChain, evm: async () => { throw new Error("not an EVM adapter"); } });

let solPriceCache: { at: number; usd: number } | null = null;
export async function solUsd(): Promise<number> {
  if (solPriceCache && Date.now() - solPriceCache.at < 60_000) return solPriceCache.usd;
  try {
    const j = await getJson<{ pairs?: DsNativePair[] }>(`${env().MARKET_DATA_URL}/latest/dex/tokens/${SOL_MINT}`);
    // read through the right side of each pool (a pair's priceUsd is its BASE token's price) and take a median
    const usd = nativeUsdFromPairs(j.pairs ?? [], SOL_MINT, "solana");
    if (usd && usd > 0) solPriceCache = { at: Date.now(), usd };
  } catch {
    /* fall through to a stale price, if there is one */
  }
  // a stale live price is fine; a hard-coded guess is not (it sizes trades and balances)
  if (!solPriceCache) throw new Error("No live SOL price available right now");
  return solPriceCache.usd;
}

/** @solana/web3.js's Connection as the fee estimator needs it; the base fee is asked of the chain for a real one-signature message. */
function feeConnection(c: Connection): FeeConnection {
  return {
    getRecentPrioritizationFees: () => c.getRecentPrioritizationFees(),
    baseFeePerSignature: async () => {
      // any one-signature message costs the same base fee; two distinct ordinary addresses make a valid one (the fee doesn't depend on who)
      const payer = new PublicKey("9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM");
      const other = new PublicKey("DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263");
      const { blockhash } = await c.getLatestBlockhash();
      const msg = new TransactionMessage({ payerKey: payer, recentBlockhash: blockhash, instructions: [SystemProgram.transfer({ fromPubkey: payer, toPubkey: other, lamports: 1 })] }).compileToV0Message();
      const fee = (await c.getFeeForMessage(msg)).value;
      if (fee == null) throw new Error("fee unavailable");
      return fee;
    },
  };
}

const poolFeeCache = new Map<string, { at: number; fees: number[] }>();
/**
 * The going price per compute unit (micro-lamports) in the fee market of THESE accounts (the pools a route trades through), not the
 * network-wide list: measured live, that one read 0 while the pools of active tokens were paying 50,000-800,000. Cached for seconds.
 */
export async function poolMicroPerCu(pools: string[]): Promise<number> {
  const key = [...new Set(pools)].sort().join(",");
  const hit = poolFeeCache.get(key);
  let fees = hit && Date.now() - hit.at < 10_000 ? hit.fees : null;
  if (!fees) {
    const raw = await solanaTry((c) => c.getRecentPrioritizationFees({ lockedWritableAccounts: pools.map((p) => new PublicKey(p)) }), 6_000);
    fees = raw.map((f) => f.prioritizationFee);
    if (poolFeeCache.size > 200) poolFeeCache.clear();
    poolFeeCache.set(key, { at: Date.now(), fees });
  }
  return priorityMicroLamportsPerCu(fees);
}

/** What the chain charges right now: the base fee (barely moves: cached a while) and the network-wide priority price (moves with congestion: cached seconds). */
let slowCache: { at: number; base: number } | null = null;
let fastCache: { at: number; fees: { prioritizationFee: number }[] } | null = null;
export async function solanaCosts(): Promise<SolanaCosts> {
  const now = Date.now();
  if (!slowCache || now - slowCache.at > 10 * 60_000) {
    const base = await solanaTry((c) => feeConnection(c).baseFeePerSignature(), 8_000);
    slowCache = { at: now, base };
  }
  if (!fastCache || now - fastCache.at > 15_000) {
    // if this fails (no recent data from any node) we can't tell what the network charges: use none rather than a guess
    const fees = await solanaTry((c) => c.getRecentPrioritizationFees(), 6_000).catch(() => []);
    fastCache = { at: now, fees };
  }
  return { baseFeeLamports: slowCache.base, microLamportsPerCu: priorityMicroLamportsPerCu(fastCache.fees.map((f) => f.prioritizationFee)) };
}
const conns = new Map<string, Connection>();
function connectionFor(url: string): Connection {
  let c = conns.get(url);
  if (!c) {
    // the websocket endpoint belongs to the operator's own URL, not to whichever free fallback we are on
    c = new Connection(url, { commitment: "confirmed", wsEndpoint: url === process.env.SOLANA_RPC_URL ? env().SOLANA_WS_URL : undefined });
    conns.set(url, c);
  }
  return c;
}
export function connection(): Connection {
  return connectionFor(rpcCandidates("solana")[0]);
}

/**
 * Runs a Solana RPC call with automatic failover across every free endpoint (see rpcCandidates), so no API key is
 * required and one dead / rate-limited / method-blocked public node does not break the chain. Free nodes differ in
 * which methods they serve (PublicNode serves getAccountInfo but blocks the indexed ones; the official endpoint
 * 429s heavily), which is exactly why an endpoint rejecting a call moves on rather than failing the lookup.
 * budgetMs is the TOTAL across attempts so failover cannot blow the caller's deadline.
 */
export async function solanaTry<T>(fn: (c: Connection) => Promise<T>, budgetMs = 8_000): Promise<T> {
  const deadline = Date.now() + budgetMs;
  let last: unknown = new Error("No Solana RPC endpoint available");
  for (const url of rpcCandidates("solana")) {
    const left = deadline - Date.now();
    if (left < 800) break;
    try {
      return await withTimeout(fn(connectionFor(url)), Math.min(left, 4_000), "solana rpc");
    } catch (e) {
      last = e;
    }
  }
  throw last;
}

/** What the wallet really holds of a token, in the token's own integer units; null when the nodes can't say. */
export async function splBalanceRaw(owner: string, mint: string): Promise<bigint | null> {
  try {
    const r = await solanaTry((c) => c.getParsedTokenAccountsByOwner(new PublicKey(owner), { mint: new PublicKey(mint) }), 8_000);
    return r.value.reduce((s, a) => s + BigInt((a.account.data as { parsed: { info: { tokenAmount: { amount: string } } } }).parsed.info.tokenAmount.amount), BigInt(0));
  } catch {
    return null;
  }
}

const decimalsCache = new Map<string, number>();
/** Mint decimals via getAccountInfo (served by every free node) rather than getTokenSupply (blocked on some). */
export async function mintDecimals(mint: string): Promise<number> {
  const hit = decimalsCache.get(mint);
  if (hit !== undefined) return hit;
  const info = await solanaTry((c) => c.getParsedAccountInfo(new PublicKey(mint)));
  const d = (info.value?.data as { parsed?: { info?: { decimals?: number } } })?.parsed?.info?.decimals;
  if (typeof d !== "number") throw new Error("Could not read token decimals");
  decimalsCache.set(mint, d);
  return d;
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
    return (await solanaTry((c) => c.getBalance(new PublicKey(address)))) / 1e9;
  }
  async getTokenBalance(owner: string, tokenAddress: string): Promise<number | null> {
    try {
      // every token account the owner has for this mint (a wallet can hold more than one); an empty list is a real "none"
      const r = await solanaTry((c) => c.getParsedTokenAccountsByOwner(new PublicKey(owner), { mint: new PublicKey(tokenAddress) }), 8_000);
      return r.value.reduce((sum, a) => sum + (((a.account.data as { parsed?: { info?: { tokenAmount?: { uiAmount?: number | null } } } }).parsed?.info?.tokenAmount?.uiAmount) ?? 0), 0);
    } catch {
      return null;
    }
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

// Holder concentration needs getTokenLargestAccounts, which no free keyless Solana RPC serves reliably (verified:
// PublicNode blocks it as an "indexed request", the official endpoint rate-limits it, others require a key).
// Rather than burning two failing calls on every token, remember a failure for a while. Set SOLANA_RPC_URL to a
// keyed provider (e.g. Helius, free tier) and this works normally.
let holdersBackoffUntil = 0;
const HOLDERS_BACKOFF_MS = 5 * 60_000;

/** Solana raw facts: mint/freeze authority, top-holder concentration, sell-side heuristics. */
export async function solanaOnChain(_chain: ChainId, address: string, snapshot: TokenSnapshot): Promise<OnChainRaw> {
  const mint = new PublicKey(address);
  const trustPromise = fetchTrustFacts(_chain, address); // independent services, asked while the RPC calls run
  const anomalies: string[] = [];
  let mintRevoked = false;
  let freezeRevoked = false;
  let topHolderPct = 0;
  let top10 = 0;
  let dataAvailable = true;
  let holderDataAvailable = false;
  // 1) authorities: the important check, and served by every free node, so it survives without a key
  try {
    const info = await solanaTry((c) => c.getParsedAccountInfo(mint), SOLANA_RPC_TIMEOUT_MS);
    const parsed = (info.value?.data as { parsed?: { info?: { mintAuthority: string | null; freezeAuthority: string | null } } })?.parsed?.info;
    if (!parsed) throw new Error("Not a token mint");
    mintRevoked = parsed.mintAuthority === null;
    freezeRevoked = parsed.freezeAuthority === null;
  } catch {
    dataAvailable = false; // unknown, not "authority active" — assessSafety scores this separately
  }
  // 2) holder concentration: a nice-to-have that needs a capable RPC; failing here must not discard the authority result
  if (dataAvailable && Date.now() >= holdersBackoffUntil) {
    try {
      const [largest, supply] = await solanaTry((c) => Promise.all([c.getTokenLargestAccounts(mint), c.getTokenSupply(mint)]), SOLANA_RPC_TIMEOUT_MS);
      const total = Number(supply.value.amount) || 1;
      const amounts = largest.value.map((a) => (Number(a.amount) / total) * 100);
      // The largest account is frequently the liquidity pool vault; report it but callers should treat it with care.
      topHolderPct = amounts[0] ?? 0;
      top10 = amounts.slice(0, 10).reduce((a, b) => a + b, 0);
      holderDataAvailable = true;
      holdersBackoffUntil = 0;
    } catch {
      holdersBackoffUntil = Date.now() + HOLDERS_BACKOFF_MS;
    }
  }
  const buyShare = snapshot.buys1h / Math.max(1, snapshot.buys1h + snapshot.sells1h);
  const trust = await trustPromise;
  return {
    mintAuthorityRevoked: mintRevoked,
    freezeAuthorityRevoked: freezeRevoked,
    verified: trust.listed === true,
    topHolderPct,
    top10HolderPct: top10,
    sellSimulationOk: trust.honeypot === true ? false : !looksLikeHoneypotFlow(snapshot),
    trust,
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
    holderDataAvailable,
  };
}

interface JupQuote {
  outAmount: string;
  priceImpactPct: string;
  routePlan?: { swapInfo?: { label?: string; ammKey?: string } }[];
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
    const decimals = await mintDecimals(req.tokenAddress);
    const inputMint = req.side === "BUY" ? SOL_MINT : req.tokenAddress;
    const outputMint = req.side === "BUY" ? req.tokenAddress : SOL_MINT;
    // a sell never asks for more than the wallet holds (see sellRaw): a position's float amount can come out a unit or two above it
    const inAmount =
      req.side === "BUY"
        ? BigInt(Math.floor((req.amountUsd / sol) * 1e9))
        : sellRaw(req.tokenAmount ?? req.amountUsd / snap.priceUsd, decimals, req.tokenAmount !== undefined && req.wallet ? await splBalanceRaw(req.wallet, req.tokenAddress) : null);
    if (inAmount <= BigInt(0)) throw new Error(req.side === "SELL" && req.wallet ? "The wallet holds none of this token, so there is nothing to sell" : "Amount is too small to swap");
    const q = await getJson<JupQuote>(
      `${env().DEX_PROVIDER_URL}/quote?inputMint=${inputMint}&outputMint=${outputMint}&amount=${inAmount}&slippageBps=${req.slippageBps}`,
      { headers: this.headers() },
    );
    const out = Number(q.outAmount);
    const outputAmount = req.side === "BUY" ? out / 10 ** decimals : (out / 1e9) * sol;
    // Fees as the chain charges them. The priority fee the user may type is a CAP (their own limit) on the automatic one, not a price.
    const cap = req.priorityFeeNative && req.priorityFeeNative > 0 ? Math.floor(req.priorityFeeNative * 1e9) : undefined;
    const costs = await solanaCosts().catch(() => null);
    // bid against the fee market of the pools this route actually trades through; the network-wide price is the fallback
    const pools = (q.routePlan ?? []).map((r) => r.swapInfo?.ammKey).filter((k): k is string => !!k);
    const poolMicro = pools.length ? await poolMicroPerCu(pools).catch(() => null) : null;
    const micro = poolMicro ?? costs?.microLamportsPerCu ?? null;
    // the fee is that price x the compute units this swap will use, which Jupiter sizes by simulating this exact route for this wallet:
    // so it needs the wallet. Without one (a pre-buy "can it be sold" check) the fee is simply not worked out.
    const sizing = req.wallet ? await this.swapSizing(q, req.wallet).catch(() => null) : null;
    const units = sizing?.units ?? null;
    const appliedMicro = micro !== null && units !== null ? capMicroLamportsPerCu(micro, units, cap) : undefined;
    const priorityKnown = appliedMicro !== undefined && units !== null;
    // the base fee as the chain reports it (getFeeForMessage); if it can't be read the fee is unknown, not a remembered figure
    const networkFeeUsd = costs ? (costs.baseFeeLamports / 1e9) * sol : 0;
    const priorityFeeUsd = priorityKnown ? (priorityLamports(appliedMicro, units) / 1e9) * sol : 0;
    // A first buy of a token opens its token account and locks a deposit in it (returned when the empty account is closed). Read from the chain.
    let tokenAccountDepositUsd: number | null | undefined;
    if (req.side === "BUY") {
      const lamports = req.wallet ? await this.depositLamports(req.wallet, req.tokenAddress, sizing?.tx ?? null).catch(() => null) : null;
      tokenAccountDepositUsd = lamports === null ? null : (lamports / 1e9) * sol;
    }
    return {
      chain: "solana",
      inputMint,
      outputMint,
      inputAmountUsd: req.amountUsd,
      outputAmount,
      // per-token price; a sell with no explicit token amount sold inAmount raw units (the pre-buy dry run)
      effectivePriceUsd: req.side === "BUY" ? req.amountUsd / outputAmount : outputAmount / (req.tokenAmount ?? Number(inAmount) / 10 ** decimals),
      priceImpactPct: Math.abs(Number(q.priceImpactPct)) * 100,
      slippageBps: req.slippageBps,
      minReceived: outputAmount * (1 - req.slippageBps / 10_000),
      networkFeeUsd,
      networkFeeKnown: !!costs && priorityKnown,
      priorityFeeUsd,
      priorityMicroLamportsPerCu: appliedMicro,
      platformFeeUsd: 0,
      tokenAccountDepositUsd,
      route: (q.routePlan ?? []).map((r) => r.swapInfo?.label ?? "?"),
      expiresAt: new Date(Date.now() + 20_000),
      raw: q,
      source: "LIVE",
    };
  }

  private swapCall(quoteResponse: unknown, userPublicKey: string, extra: object = {}) {
    return getJson<{ swapTransaction: string; computeUnitLimit?: number }>(`${env().DEX_PROVIDER_URL}/swap`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({ quoteResponse, userPublicKey, dynamicComputeUnitLimit: true, ...extra }),
    });
  }

  private sizingCache = new Map<string, { at: number; units: number; tx: string }>();
  /** The compute units Jupiter sizes for this exact route and wallet (it simulates the transaction to get them), and the transaction it built. */
  private async swapSizing(q: JupQuote, wallet: string): Promise<{ units: number; tx: string } | null> {
    const key = `${q.inputMint}:${q.outputMint}:${wallet}`;
    const hit = this.sizingCache.get(key);
    if (hit && Date.now() - hit.at < 30_000) return hit;
    const j = await this.swapCall(q, wallet);
    if (!(typeof j.computeUnitLimit === "number" && j.computeUnitLimit > 0)) return null;
    if (this.sizingCache.size > 200) this.sizingCache.clear();
    const entry = { at: Date.now(), units: j.computeUnitLimit, tx: j.swapTransaction };
    this.sizingCache.set(key, entry);
    return entry;
  }

  private depositCache = new Map<string, { at: number; lamports: number }>();
  /**
   * What a buy of this token would lock in a new token account for this wallet, in lamports: 0 when the wallet already has one.
   * Read off the chain by running the built swap and looking at what the new account ends up holding; if that can't be run, the
   * chain's own rent-exempt minimum for an ordinary token account; if neither can be read, unknown (null), never a remembered figure.
   */
  private async depositLamports(wallet: string, mint: string, swapTx: string | null): Promise<number | null> {
    const key = `${wallet}:${mint}`;
    const hit = this.depositCache.get(key);
    if (hit && Date.now() - hit.at < 30_000) return hit.lamports;
    const remember = (lamports: number) => {
      if (this.depositCache.size > 200) this.depositCache.clear();
      this.depositCache.set(key, { at: Date.now(), lamports });
      return lamports;
    };
    const mintInfo = await solanaTry((c) => c.getAccountInfo(new PublicKey(mint)));
    if (!mintInfo) return null;
    const ata = associatedTokenAddress(new PublicKey(wallet), new PublicKey(mint), mintInfo.owner);
    if (await solanaTry((c) => c.getAccountInfo(ata))) return remember(0);
    if (swapTx) {
      try {
        const tx = VersionedTransaction.deserialize(Buffer.from(swapTx, "base64"));
        const res = await solanaTry((c) => c.simulateTransaction(tx, { sigVerify: false, replaceRecentBlockhash: true, commitment: "processed", accounts: { encoding: "base64", addresses: [ata.toBase58()] } }), 8_000);
        const held = res.value.accounts?.[0]?.lamports;
        if (typeof held === "number" && held > 0) return remember(held);
      } catch {
        /* fall through to the chain's minimum */
      }
    }
    if (mintInfo.owner.equals(TOKEN_PROGRAM)) return remember(await solanaTry((c) => c.getMinimumBalanceForRentExemption(ACCOUNT_SIZE)));
    return null;
  }

  async buildSwapTransaction(quote: SwapQuote, userAddress: string) {
    // First build with no explicit priority to learn how many compute units Jupiter sizes for THIS transaction, then price those
    // units at the fee market's going rate (the one the quote was made with, already held to the user's own cap, if any).
    const first = await this.swapCall(quote.raw, userAddress);
    const micro = quote.priorityMicroLamportsPerCu;
    const units = first.computeUnitLimit;
    if (micro === undefined || !(typeof units === "number" && units > 0)) return { unsignedTxBase64: first.swapTransaction };
    const lamports = priorityLamports(micro, units);
    if (lamports <= 0) return { unsignedTxBase64: first.swapTransaction }; // nobody is paying any priority: neither do we
    return { unsignedTxBase64: (await this.swapCall(quote.raw, userAddress, { prioritizationFeeLamports: lamports })).swapTransaction };
  }
  /** Simulate the built swap exactly as the wallet will (signatures not checked, fresh blockhash), and explain a failure. */
  async preflight(_chain: ChainId, unsignedTx: string): Promise<PreflightResult> {
    try {
      const tx = VersionedTransaction.deserialize(Buffer.from(unsignedTx, "base64"));
      const res = await solanaTry((c) => c.simulateTransaction(tx, { sigVerify: false, replaceRecentBlockhash: true, commitment: "processed" }), 8_000);
      if (!res.value.err) return { ok: true };
      const f = explainSolanaSimulation(res.value.err, res.value.logs ?? []);
      return { ok: false, kind: f.kind, error: f.message };
    } catch {
      return { ok: true }; // the check itself couldn't run: let the wallet decide
    }
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
    const signature = await solanaTry((c) => c.sendRawTransaction(tx.serialize(), { skipPreflight: false, maxRetries: 3 }), 15_000);
    return { signature };
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

  async inspectTransaction(_chain: ChainId, signature: string, owner: string, mint: string) {
    const tx = await solanaTry((c) => c.getParsedTransaction(signature, { maxSupportedTransactionVersion: 0, commitment: "confirmed" }), 12_000);
    if (!tx?.meta) return null;
    const keys = tx.transaction.message.accountKeys;
    const signer = keys[0]?.pubkey.toBase58() ?? "";
    const bal = (arr: typeof tx.meta.postTokenBalances) =>
      (arr ?? []).filter((b) => b.owner === owner && b.mint === mint).reduce((s, b) => s + (b.uiTokenAmount.uiAmount ?? 0), 0);
    const idx = keys.findIndex((k) => k.pubkey.toBase58() === owner);
    const nativeDelta = idx >= 0 ? (tx.meta.postBalances[idx] - tx.meta.preBalances[idx]) / 1e9 : 0;
    const dep = depositChange(tx.meta, owner);
    return { signer, tokenDelta: bal(tx.meta.postTokenBalances) - bal(tx.meta.preTokenBalances), nativeDelta, feeNative: (tx.meta.fee ?? 0) / 1e9, depositNative: (dep.locked - dep.returned) / 1e9 };
  }

  async getTransactionStatus(_chain: ChainId, signature: string): Promise<TransactionStatus> {
    const res = await solanaTry((c) => c.getSignatureStatuses([signature], { searchTransactionHistory: true }));
    const s = res.value[0];
    if (!s) return { status: "NOT_FOUND" };
    if (s.err) return { status: "FAILED", error: JSON.stringify(s.err), slot: s.slot };
    if (s.confirmationStatus === "confirmed" || s.confirmationStatus === "finalized") return { status: "CONFIRMED", slot: s.slot };
    return { status: "PENDING", slot: s.slot };
  }
}
