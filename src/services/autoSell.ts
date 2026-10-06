import { autoSellVenue, CHAINS } from "@/core/chains";
import { fillDelta, mergeForMinimum, minProceedsRaw, planAutoSells, toRaw, type PlannedOrder } from "@/core/trading/autoSell";
import { cancelCowOrders, cowAllowance, cowApprovalTx, cowCancelTypedData, cowTypedData, buildCowOrder, getCowOrder, getCowTradeHashes, submitCowOrder, COW_RELAYER } from "@/core/providers/limitOrders/cow";
import { cancelJupiterOrder, createJupiterOrder, getJupiterOrder, jupiterFills, jupiterMinimumFromRefusal } from "@/core/providers/limitOrders/jupiter";
import { approvalAffordable } from "@/core/providers/evm/affordability";
import { evmTxFeeUsd, tokenDecimals } from "@/core/providers/evm/evmProviders";
import { cancelKyberOrders, erc20Allowance, erc20ApprovalTx, kyberCancelSign, kyberContract, kyberFills, kyberFindOrder, kyberSignMessage, submitKyberOrder, type KyberOrder, type KyberOrderRequest } from "@/core/providers/limitOrders/kyber";
import { providers } from "@/core/providers/registry";
import { mintDecimals } from "@/core/providers/solana/solanaProviders";
import type { ChainId } from "@/core/types";
import { collections, newId } from "@/lib/db";
import { logEvent, safeMessage } from "@/lib/events";
import type { AutoSellOrderDoc, PositionDoc, TokenDoc } from "@/lib/models";
import { autoSellProblem, autoSellSuggested } from "./notificationMessages";
import { notifyUser } from "./notifications";
import { TradeError } from "./errors";
import { recordExternalSell } from "./trading";
import { resolveWallet, walletFamilyOf } from "./walletResolve";

/**
 * Auto-sell. After a buy confirms, the app prepares one limit sell per profit target. The user signs them once (an
 * approval + off-chain signatures on EVM via CoW Protocol or KyberSwap limit orders; one escrow transaction per order on
 * Solana via Jupiter) and a
 * keeper network fills each on-chain when its price is reached, even if the user is away. The app never holds keys: it
 * builds what the wallet signs, submits the signed orders, and then watches the venue for fills to book profit.
 */

const ORDER_LIFETIME_MS = 14 * 24 * 3_600_000; // CoW and Kyber orders lapse; Jupiter orders stay until filled or cancelled
const SOLANA_LAND_GRACE_MS = 4 * 60_000;
const COW_LAND_GRACE_MS = 10 * 60_000;
const ACTIVE_OR_PENDING: AutoSellOrderDoc["status"][] = ["SUGGESTED", "ACTIVE"];

export type Venue = "cow" | "kyber" | "jupiter";
export const venueFor = (chain: string): Venue | null => (chain in CHAINS ? autoSellVenue(chain as ChainId) : null);

/** CoW pays the native coin, Kyber its wrapped form: both 18 decimals. Jupiter pays SOL (9). */
const nativeDecimals = (venue: Venue) => (venue === "jupiter" ? 9 : 18);

async function decimalsOf(chain: string, address: string): Promise<number> {
  return CHAINS[chain as ChainId].family === "evm" ? tokenDecimals(chain as ChainId, address) : mintDecimals(address);
}

/** The wallet that owns (or will own) the orders: the connected one if verified, else the order's recorded maker, else the latest verified. */
async function ownerWallet(userId: string, chain: string, requested?: string | null) {
  const w = await resolveWallet(userId, chain, requested);
  if (!w) throw new TradeError(`Connect and verify a ${walletFamilyOf(chain) === "evm" ? "EVM" : "Solana"} wallet first`, 400);
  return w;
}

async function loadOpenPosition(userId: string, positionId: string): Promise<{ pos: PositionDoc; token: TokenDoc }> {
  const pos = await (await collections.positions()).findOne({ _id: positionId, userId, environment: "LIVE" });
  if (!pos || pos.status === "CLOSED" || pos.amount <= 0) throw new TradeError("Position not found or already closed", 404);
  const token = await (await collections.tokens()).findOne({ _id: pos.tokenId });
  if (!token) throw new TradeError("Token not found", 404);
  return { pos, token };
}

/** The sell plan for a position as it stands now, as order documents (not yet signed or placed). */
export async function buildPlan(pos: PositionDoc, token: TokenDoc, maker: string | null = null): Promise<{ venue: Venue; orders: PlannedOrder[]; note: string | null } | null> {
  const venue = venueFor(token.chain);
  if (!venue) return null;
  const planned = planAutoSells({ entryPriceUsd: pos.entryPriceUsd, initialAmount: pos.initialAmount, amount: pos.amount, costBasisUsd: pos.costBasisUsd, targetsHit: pos.targetsHit }, pos.targetsSnapshot ?? []);
  if (venue === "kyber") {
    return { venue, orders: planned, note: "Proceeds arrive as the wrapped version of the chain's coin (for example WETH), which you can unwrap in your wallet." + (token.chain === "ethereum" && pos.amount * token.priceUsd < 100 ? " On Ethereum mainnet, small orders may not fill because the network fee can exceed the order's value." : "") };
  }
  if (venue === "cow") {
    const note = token.chain === "ethereum" && pos.amount * token.priceUsd < 100 ? "On Ethereum mainnet, small orders may not fill because the network fee can exceed the order's value." : null;
    return { venue, orders: planned, note };
  }
  const merged = await jupiterOrders(planned, pos, token, maker ?? pos.walletAddress ?? null);
  const min = learnedJupiterMinUsd;
  const minText = min > 0 ? `$${min.toFixed(2).replace(/\.?0+$/, "")}` : "its minimum";
  const note = !merged.length
    ? `This position is too small for Jupiter's limit orders: Jupiter's service refuses any order worth under ${minText} (counted at the order's target price), and that rule is Jupiter's, not this app's. You'll get a notification to sign target sells instead.`
    : merged.length < planned.length
      ? `Jupiter's limit orders must be worth at least ${minText} each (counted at the order's target price), so some small targets were merged into fewer, larger sells at the earlier target.`
      : null;
  return { venue, orders: merged, note };
}

/**
 * Jupiter's smallest order is Jupiter's to say, so it is asked, not remembered: each planned order is offered to Jupiter's order
 * builder (which only returns an unsigned transaction, nothing is placed), and if it refuses one for size its message says what the
 * minimum is and how it measured ours. That is turned into the minimum in our own measure and the plan is merged again. What was
 * learned is kept for the life of the process so later plans start there. If the position has no wallet recorded or the builder
 * can't be reached, the plan is left as it is and the order's own build says no if it must.
 */
let learnedJupiterMinUsd = 0;
async function jupiterOrders(planned: PlannedOrder[], pos: PositionDoc, token: TokenDoc, maker: string | null): Promise<PlannedOrder[]> {
  const dec = await decimalsOf(token.chain, token.address);
  const nat = await providers().chains[token.chain as ChainId].nativeUsdPrice();
  let merged = mergeForMinimum(planned, token.priceUsd, learnedJupiterMinUsd);
  if (!maker) return merged;
  for (let attempt = 0; attempt < 4 && merged.length; attempt++) {
    let refusedMin = 0; // the largest minimum any refusal named this round (0: none refused for size)
    for (const o of merged) {
      const raw = orderRaw(o, dec, nat, "jupiter");
      try {
        await createJupiterOrder({ maker, inputMint: token.address, makingRaw: BigInt(raw.sellAmountRaw), takingRaw: BigInt(raw.minBuyRaw) });
      } catch (err) {
        const learned = jupiterMinimumFromRefusal(err instanceof Error ? err.message : String(err), Math.max(o.tokenAmount * token.priceUsd, o.tokenAmount * o.targetPriceUsd));
        if (learned) refusedMin = Math.max(refusedMin, learned);
      }
    }
    if (!(refusedMin > learnedJupiterMinUsd)) return merged;
    learnedJupiterMinUsd = refusedMin;
    merged = mergeForMinimum(planned, token.priceUsd, learnedJupiterMinUsd);
  }
  return merged;
}

/** The raw amounts an order is placed with: the tokens (shaved by 1e-9 so rounding never asks to sell more than the wallet holds) and the least it will accept in return, at the target price. */
function orderRaw(o: PlannedOrder, dec: number, nat: number, venue: Venue) {
  return {
    sellAmountRaw: ((toRaw(o.tokenAmount, dec) * BigInt(999_999_999)) / BigInt(1_000_000_000)).toString(),
    minBuyRaw: minProceedsRaw(o.tokenAmount, o.targetPriceUsd, nat, nativeDecimals(venue)).toString(),
  };
}

async function toDocs(userId: string, pos: PositionDoc, token: TokenDoc, venue: Venue, orders: PlannedOrder[], maker: string | null): Promise<AutoSellOrderDoc[]> {
  const dec = await decimalsOf(token.chain, token.address);
  const nat = await providers().chains[token.chain as ChainId].nativeUsdPrice();
  const now = new Date();
  const docs = orders.map((o): AutoSellOrderDoc => ({
    _id: newId(), userId, positionId: pos._id, tokenId: token._id, chain: token.chain, venue, levels: o.levels, gainPct: o.gainPct, targetPriceUsd: o.targetPriceUsd,
    // a position's amount is a float built from on-chain deltas; orderRaw shaves 1e-9 so rounding can never ask to sell more than the wallet holds
    sellAmount: o.tokenAmount, ...orderRaw(o, dec, nat, venue),
    status: "SUGGESTED", maker, orderRef: null, validTo: venue !== "jupiter" ? new Date(now.getTime() + ORDER_LIFETIME_MS) : null, bookedSellRaw: "0", bookedBuyRaw: "0", txHashes: [], error: null,
    createdAt: now, activatedAt: null, updatedAt: now, lastSyncAt: null,
  }));
  return docs.filter((d) => BigInt(d.sellAmountRaw) > BigInt(0) && BigInt(d.minBuyRaw) > BigInt(0));
}

/** Replace any not-yet-placed suggestions with a fresh plan for the position's current size. */
async function replan(userId: string, pos: PositionDoc, token: TokenDoc, maker: string | null = null) {
  const col = await collections.autoSellOrders();
  const placed = await col.countDocuments({ positionId: pos._id, status: "ACTIVE" });
  if (placed) throw new TradeError("Auto-sell is already armed for this position. Cancel it first to change it.", 409);
  const plan = await buildPlan(pos, token, maker);
  if (!plan) throw new TradeError(`Auto-sell isn't available on ${CHAINS[token.chain as ChainId].name} yet; target sells will be queued for you to sign instead.`, 422);
  await col.deleteMany({ positionId: pos._id, status: "SUGGESTED" });
  const docs = await toDocs(userId, pos, token, plan.venue, plan.orders, maker);
  if (!docs.length) throw new TradeError(plan.note ?? "Nothing to sell: the position is too small for auto-sell orders", 422);
  await col.insertMany(docs);
  return { plan, docs };
}

/** Called when a buy confirms: prepare the suggestion and tell the user. Idempotent. Never throws. */
export async function suggestAutoSells(positionId: string): Promise<number> {
  try {
    const pos = await (await collections.positions()).findOne({ _id: positionId });
    if (!pos || pos.status === "CLOSED") return 0;
    const token = await (await collections.tokens()).findOne({ _id: pos.tokenId });
    if (!token) return 0;
    const col = await collections.autoSellOrders();
    if (await col.countDocuments({ positionId, status: { $in: ACTIVE_OR_PENDING } })) return 0;
    const { docs } = await replan(pos.userId, pos, token).catch(() => ({ docs: [] as AutoSellOrderDoc[] }));
    if (!docs.length) return 0;
    await notifyUser(pos.userId, autoSellSuggested(token.symbol, CHAINS[token.chain as ChainId].name, docs.map((d) => ({ gainPct: d.gainPct, sellPct: (d.sellAmount / pos.initialAmount) * 100 })), positionId));
    return docs.length;
  } catch (err) {
    await logEvent({ type: "WORKER_ERROR", source: "autosell", level: "WARN", message: `Could not suggest auto-sell: ${safeMessage(err)}` }).catch(() => {});
    return 0;
  }
}

// ───────────────────────────── arming ─────────────────────────────

/** Kyber rejects an order for reasons that read as input errors; say what they usually mean. */
function friendlyOrderError(msg: string): string {
  if (/out of range.*makingAmount|makingAmount/i.test(msg)) return "The venue refused this order's size: it is below its minimum, or the wallet does not hold or has not approved enough of the token. " + msg;
  if (/insufficient\s*allowance/i.test(msg)) return "The token approval did not go through, so the venue cannot reserve the tokens. " + msg;
  return msg;
}

/** The chain's own answer to "can this wallet pay for this approval": its gas estimate against the wallet's balance. */
async function requireAffordable(chain: ChainId, wallet: string, approval: { to: string; data: string; value?: string }) {
  const r = await approvalAffordable(chain, wallet, approval);
  if (!r.ok) throw new TradeError(r.error, 422);
}

/** Everything the wallet needs to arm an EVM position: an exact-amount approval (if short) and one typed order per target. */
export async function prepareArmEvm(userId: string, positionId: string, connected?: string | null) {
  const { pos, token } = await loadOpenPosition(userId, positionId);
  const chain = token.chain as ChainId;
  if (CHAINS[chain].family !== "evm") throw new TradeError("Not an EVM position", 400);
  const wallet = await ownerWallet(userId, token.chain, connected);
  const { plan, docs } = await replan(userId, pos, token, wallet.address);
  const chainId = CHAINS[chain].evmChainId!;
  const total = docs.reduce((s, d) => s + BigInt(d.sellAmountRaw), BigInt(0));
  const col = await collections.autoSellOrders();

  if (plan.venue === "kyber") {
    const contract = await kyberContract(chain);
    const taker = CHAINS[chain].wrappedNative;
    const allowance = await erc20Allowance(chain, token.address, wallet.address, contract).catch(() => BigInt(0));
    const orders = [];
    for (const d of docs) {
      const req: KyberOrderRequest = { chainId: String(chainId), makerAsset: token.address, takerAsset: taker, maker: wallet.address, allowedSenders: [], makingAmount: d.sellAmountRaw, takingAmount: d.minBuyRaw, expiredAt: Math.floor(d.validTo!.getTime() / 1000) };
      const typed = await kyberSignMessage(req);
      // the salt is chosen by Kyber and is part of what gets signed: keep it, so the order can be posted exactly as signed
      await col.updateOne({ _id: d._id }, { $set: { venueData: { salt: String(typed.message.salt), takerAsset: taker, contract, expiredAt: req.expiredAt } } });
      orders.push({ id: d._id, levels: d.levels, gainPct: d.gainPct, targetPriceUsd: d.targetPriceUsd, sellAmount: d.sellAmount, typedData: typed });
    }
    const approval = allowance >= total ? null : erc20ApprovalTx(token.address, contract, total);
    if (approval) await requireAffordable(chain, wallet.address, approval);
    return { venue: "kyber" as const, chain: token.chain, chainId, note: plan.note, approval, approvalFeeUsd: approval ? await evmTxFeeUsd(chain, { from: wallet.address, ...approval }).catch(() => null) : null, orders };
  }

  const allowance = await cowAllowance(chain, token.address, wallet.address).catch(() => BigInt(0));
  const approval = allowance >= total ? null : cowApprovalTx(token.address, total);
  if (approval) await requireAffordable(chain, wallet.address, approval);
  return {
    venue: "cow" as const,
    chain: token.chain,
    chainId,
    note: plan.note,
    relayer: COW_RELAYER,
    approval,
    /** what the one approval transaction costs, worked out from the chain, so the wallet's figure isn't a surprise */
    approvalFeeUsd: approval ? await evmTxFeeUsd(chain, { from: wallet.address, ...approval }).catch(() => null) : null,
    orders: docs.map((d) => ({
      id: d._id,
      levels: d.levels,
      gainPct: d.gainPct,
      targetPriceUsd: d.targetPriceUsd,
      sellAmount: d.sellAmount,
      typedData: cowTypedData(chainId, buildCowOrder({ owner: wallet.address, sellToken: token.address, sellAmountRaw: BigInt(d.sellAmountRaw), minBuyRaw: BigInt(d.minBuyRaw), validTo: Math.floor(d.validTo!.getTime() / 1000) })),
    })),
  };
}

function kyberRequest(d: AutoSellOrderDoc, token: TokenDoc, maker: string): KyberOrderRequest {
  const v = d.venueData;
  if (!v) throw new TradeError("Order was not prepared", 409);
  return { chainId: String(CHAINS[d.chain as ChainId].evmChainId), makerAsset: token.address, takerAsset: v.takerAsset, maker, allowedSenders: [], makingAmount: d.sellAmountRaw, takingAmount: d.minBuyRaw, expiredAt: v.expiredAt };
}

/** Post the signed orders. The order content is rebuilt here from what was stored, never taken from the browser. */
export async function activateEvm(userId: string, positionId: string, signatures: Record<string, string>) {
  const { pos, token } = await loadOpenPosition(userId, positionId);
  const col = await collections.autoSellOrders();
  const docs = await col.find({ positionId: pos._id, userId, status: "SUGGESTED" }).toArray();
  const wallet = await ownerWallet(userId, token.chain, docs[0]?.maker);
  const activated: string[] = [];
  const failed: { id: string; error: string }[] = [];
  for (const d of docs) {
    const sig = signatures[d._id];
    if (!sig || !/^0x[0-9a-fA-F]{130}$/.test(sig)) {
      failed.push({ id: d._id, error: "No valid signature for this order" });
      continue;
    }
    try {
      let ref: string;
      if (d.venue === "kyber") {
        const req = kyberRequest(d, token, wallet.address);
        const r = await submitKyberOrder(req, d.venueData!.salt, sig);
        ref = r.id !== null ? String(r.id) : `pending:${d.venueData!.salt}`; // found in the maker's listing on the next sync
      } else {
        const order = buildCowOrder({ owner: wallet.address, sellToken: token.address, sellAmountRaw: BigInt(d.sellAmountRaw), minBuyRaw: BigInt(d.minBuyRaw), validTo: Math.floor(d.validTo!.getTime() / 1000) });
        ref = await submitCowOrder(token.chain as ChainId, order, wallet.address, sig);
      }
      await col.updateOne({ _id: d._id }, { $set: { status: "ACTIVE", orderRef: ref, activatedAt: new Date(), updatedAt: new Date(), error: null } });
      activated.push(d._id);
    } catch (err) {
      const msg = friendlyOrderError(safeMessage(err));
      await col.updateOne({ _id: d._id }, { $set: { status: "FAILED", error: msg, updatedAt: new Date() } });
      failed.push({ id: d._id, error: msg });
    }
  }
  if (activated.length) await logEvent({ type: "TRADE_REQUESTED", source: "autosell", userId, message: `Auto-sell armed for ${token.symbol}: ${activated.length} order(s)`, data: { positionId } });
  return { activated, failed };
}

/** Solana: the plan first (so the UI can list the orders), then one fresh transaction per order as the user signs them. */
export async function prepareArmSolanaPlan(userId: string, positionId: string, connected?: string | null) {
  const { pos, token } = await loadOpenPosition(userId, positionId);
  if (CHAINS[token.chain as ChainId].family !== "svm") throw new TradeError("Not a Solana position", 400);
  const wallet = await ownerWallet(userId, token.chain, connected);
  const { plan, docs } = await replan(userId, pos, token, wallet.address);
  return { venue: "jupiter" as const, chain: token.chain, note: plan.note, orders: docs.map((d) => ({ id: d._id, levels: d.levels, gainPct: d.gainPct, targetPriceUsd: d.targetPriceUsd, sellAmount: d.sellAmount })) };
}

export async function prepareSolanaOrder(userId: string, orderId: string) {
  const col = await collections.autoSellOrders();
  const d = await col.findOne({ _id: orderId, userId, status: "SUGGESTED" });
  if (!d) throw new TradeError("Order not found or already placed", 404);
  const token = await (await collections.tokens()).findOne({ _id: d.tokenId });
  if (!token) throw new TradeError("Token not found", 404);
  const wallet = await ownerWallet(userId, d.chain, d.maker);
  const o = await createJupiterOrder({ maker: wallet.address, inputMint: token.address, makingRaw: BigInt(d.sellAmountRaw), takingRaw: BigInt(d.minBuyRaw) });
  // the chain simulates the order as the wallet will send it: an unaffordable one is explained here, with the real figures
  const pf = await providers().dex.preflight?.(d.chain as ChainId, o.transaction, wallet.address);
  if (pf && !pf.ok) throw new TradeError(pf.error, 422);
  await col.updateOne({ _id: d._id }, { $set: { orderRef: o.order, updatedAt: new Date(), error: null } });
  return { orderId: d._id, unsignedTxBase64: o.transaction };
}

const SOL_SIGNATURE = /^[1-9A-HJ-NP-Za-km-z]{64,90}$/;
export async function activateSolana(userId: string, orderId: string, signature: string) {
  if (!SOL_SIGNATURE.test(signature)) throw new TradeError("A valid transaction signature is required", 400);
  const col = await collections.autoSellOrders();
  const d = await col.findOne({ _id: orderId, userId, status: "SUGGESTED" });
  if (!d?.orderRef) throw new TradeError("Order not prepared", 409);
  await col.updateOne({ _id: d._id }, { $set: { status: "ACTIVE", activatedAt: new Date(), updatedAt: new Date(), txHashes: [signature] } });
  return { ok: true };
}

// ───────────────────────────── cancelling ─────────────────────────────

/** Kyber's own id for each armed order (an order whose id wasn't returned at creation is looked up in the maker's listing). */
async function kyberIds(docs: AutoSellOrderDoc[], chain: ChainId, maker: string): Promise<number[]> {
  const col = await collections.autoSellOrders();
  const ids: number[] = [];
  for (const d of docs) {
    let ref = d.orderRef!;
    if (ref.startsWith("pending:")) {
      const token = await (await collections.tokens()).findOne({ _id: d.tokenId });
      const found = token ? await kyberFindOrder(chain, maker, { req: kyberRequest(d, token, maker) }) : null;
      if (!found) throw new TradeError("An order is still being registered with Kyber; try again in a minute.", 409);
      ref = String(found.id);
      await col.updateOne({ _id: d._id }, { $set: { orderRef: ref } });
    }
    ids.push(Number(ref));
  }
  return ids;
}

export async function prepareCancelEvm(userId: string, positionId: string) {
  const col = await collections.autoSellOrders();
  const docs = await col.find({ positionId, userId, status: "ACTIVE", venue: { $in: ["cow", "kyber"] } }).toArray();
  if (!docs.length) throw new TradeError("No active auto-sell orders", 404);
  const chain = docs[0].chain as ChainId;
  const chainId = CHAINS[chain].evmChainId!;
  if (docs[0].venue === "kyber") {
    const wallet = await ownerWallet(userId, chain, docs[0].maker);
    return { chain, chainId, typedData: await kyberCancelSign(chain, wallet.address, await kyberIds(docs, chain, wallet.address)) };
  }
  return { chain, chainId, typedData: cowCancelTypedData(chainId, docs.map((d) => d.orderRef!)) };
}

export async function confirmCancelEvm(userId: string, positionId: string, signature: string) {
  if (!/^0x[0-9a-fA-F]{130}$/.test(signature)) throw new TradeError("A valid signature is required", 400);
  const col = await collections.autoSellOrders();
  const docs = await col.find({ positionId, userId, status: "ACTIVE", venue: { $in: ["cow", "kyber"] } }).toArray();
  if (!docs.length) return { cancelled: 0 };
  const chain = docs[0].chain as ChainId;
  if (docs[0].venue === "kyber") {
    const wallet = await ownerWallet(userId, chain, docs[0].maker);
    await cancelKyberOrders(chain, wallet.address, await kyberIds(docs, chain, wallet.address), signature);
  } else {
    await cancelCowOrders(chain, docs.map((d) => d.orderRef!), signature);
  }
  await col.updateMany({ _id: { $in: docs.map((d) => d._id) } }, { $set: { status: "CANCELLED", updatedAt: new Date() } });
  return { cancelled: docs.length };
}

export async function prepareCancelSolana(userId: string, orderId: string) {
  const d = await (await collections.autoSellOrders()).findOne({ _id: orderId, userId, status: "ACTIVE", venue: "jupiter" });
  if (!d?.orderRef) throw new TradeError("Active order not found", 404);
  const wallet = await ownerWallet(userId, d.chain, d.maker);
  return { orderId: d._id, unsignedTxBase64: await cancelJupiterOrder(wallet.address, d.orderRef) };
}

export async function confirmCancelSolana(userId: string, orderId: string, signature: string) {
  if (!SOL_SIGNATURE.test(signature)) throw new TradeError("A valid transaction signature is required", 400);
  const col = await collections.autoSellOrders();
  await col.updateOne({ _id: orderId, userId, status: "ACTIVE" }, { $set: { status: "CANCELLED", updatedAt: new Date(), txHashes: [signature] } });
  return { ok: true };
}

// ───────────────────────────── following the orders ─────────────────────────────

/** Target levels currently covered by an armed order: the manual "sign this sell" flow must not also sell them. */
export async function activeAutoSellLevels(positionId: string): Promise<Set<number>> {
  const docs = await (await collections.autoSellOrders()).find({ positionId, status: "ACTIVE" }, { projection: { levels: 1 } }).toArray();
  return new Set(docs.flatMap((d) => d.levels));
}

/**
 * The armed EVM orders whose target the market has stayed at or above on two checks in a row without the order filling. A limit order
 * fills only when a buyer takes it at its price; the market touching that price doesn't guarantee one does. Solana orders are left
 * alone: their tokens sit in escrow, so they can't be sold another way while the order stands. The first check that sees the price at
 * the target only marks the order; falling back below it clears the mark.
 */
export async function unfilledPastTarget(positionId: string, price: number): Promise<AutoSellOrderDoc[]> {
  const col = await collections.autoSellOrders();
  const orders = await col.find({ positionId, status: "ACTIVE", venue: { $ne: "jupiter" } }).toArray();
  const due: AutoSellOrderDoc[] = [];
  for (const o of orders) {
    if (!(price >= o.targetPriceUsd)) {
      if (o.targetSeenAt) await col.updateOne({ _id: o._id }, { $set: { targetSeenAt: null } });
    } else if (!o.targetSeenAt) {
      await col.updateOne({ _id: o._id }, { $set: { targetSeenAt: new Date() } });
    } else {
      due.push(o);
    }
  }
  return due;
}

export interface VenueState {
  state: "open" | "filled" | "cancelled" | "expired" | "missing";
  sellRaw: bigint;
  buyRaw: bigint;
  txHash: string | null;
}

async function venueState(d: AutoSellOrderDoc): Promise<VenueState> {
  if (d.venue === "kyber") {
    const chain = d.chain as ChainId;
    const wallet = await ownerWallet(d.userId, d.chain, d.maker);
    const token = await (await collections.tokens()).findOne({ _id: d.tokenId });
    const ref = d.orderRef!;
    const o: KyberOrder | null = ref.startsWith("pending:")
      ? token ? await kyberFindOrder(chain, wallet.address, { req: kyberRequest(d, token, wallet.address) }) : null
      : await kyberFindOrder(chain, wallet.address, { id: Number(ref) });
    if (!o) return { state: "missing", sellRaw: BigInt(0), buyRaw: BigInt(0), txHash: null };
    if (ref.startsWith("pending:")) await (await collections.autoSellOrders()).updateOne({ _id: d._id }, { $set: { orderRef: String(o.id) } });
    const f = kyberFills(o);
    const state = o.status === "filled" ? "filled" : o.status === "cancelled" ? "cancelled" : o.status === "expired" ? "expired" : "open";
    return { state, sellRaw: f.sellRaw, buyRaw: f.buyRaw, txHash: f.txHash };
  }
  if (d.venue === "cow") {
    const o = await getCowOrder(d.chain as ChainId, d.orderRef!);
    if (!o) return { state: "missing", sellRaw: BigInt(0), buyRaw: BigInt(0), txHash: null };
    const sellRaw = BigInt(o.executedSellAmount || "0");
    const buyRaw = BigInt(o.executedBuyAmount || "0");
    const hashes = sellRaw > BigInt(d.bookedSellRaw) ? await getCowTradeHashes(d.chain as ChainId, d.orderRef!) : [];
    const state = o.status === "fulfilled" ? "filled" : o.status === "cancelled" ? "cancelled" : o.status === "expired" ? "expired" : "open";
    return { state, sellRaw, buyRaw, txHash: hashes[hashes.length - 1] ?? null };
  }
  const wallet = await ownerWallet(d.userId, d.chain, d.maker);
  const o = await getJupiterOrder(wallet.address, d.orderRef!);
  if (!o) return { state: "missing", sellRaw: BigInt(0), buyRaw: BigInt(0), txHash: null };
  const f = jupiterFills(o);
  const state = o.status === "Completed" ? "filled" : o.status === "Cancelled" ? "cancelled" : o.status === "Open" ? "open" : "expired";
  return { state, sellRaw: f.sellRaw, buyRaw: f.buyRaw, txHash: f.txIds[f.txIds.length - 1] ?? null };
}

/**
 * Check every armed order with its venue, book new fills into the position (profit notification included) and close out
 * orders that finished, expired, were cancelled elsewhere, or never landed. Safe to run repeatedly: only the part of a
 * fill not yet booked is added.
 */
export async function syncAutoSells(): Promise<{ checked: number; booked: number }> {
  const col = await collections.autoSellOrders();
  const docs = await col.find({ status: "ACTIVE" }).toArray();
  let booked = 0;
  for (const d of docs) {
    try {
      booked += await syncOne(d);
    } catch (err) {
      await logEvent({ type: "PROVIDER_ERROR", source: "autosell", userId: d.userId, level: "WARN", message: `Auto-sell check failed: ${safeMessage(err)}` });
    }
  }
  return { checked: docs.length, booked };
}

async function syncOne(d: AutoSellOrderDoc): Promise<number> {
  const col = await collections.autoSellOrders();
  const token = await (await collections.tokens()).findOne({ _id: d.tokenId });
  const symbol = token?.symbol ?? "token";
  const now = new Date();
  const st = await venueState(d);
  let booked = 0;

  if (st.state === "missing") {
    const grace = d.venue === "jupiter" ? SOLANA_LAND_GRACE_MS : COW_LAND_GRACE_MS;
    if (d.activatedAt && now.getTime() - d.activatedAt.getTime() > grace) {
      const detail = d.venue === "jupiter" ? "The order transaction never landed on Solana, so your tokens did not leave your wallet." : `The order is no longer known to ${d.venue === "kyber" ? "KyberSwap" : "CoW Protocol"}.`;
      await col.updateOne({ _id: d._id }, { $set: { status: "FAILED", error: detail, updatedAt: now } });
      await notifyUser(d.userId, autoSellProblem("failed", symbol, detail, d.positionId));
    }
    return 0;
  }

  const delta = fillDelta({ sellRaw: BigInt(d.bookedSellRaw), buyRaw: BigInt(d.bookedBuyRaw) }, { sellRaw: st.sellRaw, buyRaw: st.buyRaw });
  if (delta) {
    // claim the new part first (compare-and-set): if booking then fails the position is under-booked, never double-booked
    const claim = await col.updateOne({ _id: d._id, bookedSellRaw: d.bookedSellRaw }, { $set: { bookedSellRaw: st.sellRaw.toString(), bookedBuyRaw: st.buyRaw.toString(), updatedAt: now, lastSyncAt: now }, $addToSet: { txHashes: st.txHash ?? "" } });
    if (claim.modifiedCount) {
      const dec = await decimalsOf(d.chain, token?.address ?? "");
      const nat = await providers().chains[d.chain as ChainId].nativeUsdPrice();
      const tokens = Number(delta.sellRaw) / 10 ** dec;
      const proceedsUsd = (Number(delta.buyRaw) / 10 ** nativeDecimals(d.venue)) * nat;
      const reason = `Target ${d.levels.join("+")} reached (+${d.gainPct.toFixed(0)}%)`;
      const r = await recordExternalSell({ userId: d.userId, positionId: d.positionId, tokens, proceedsUsd, levels: d.levels, txHash: st.txHash, reason, orderId: d._id });
      if (r) booked++;
      else await col.updateOne({ _id: d._id }, { $set: { status: "SUPERSEDED", updatedAt: now } });
    }
  } else {
    await col.updateOne({ _id: d._id }, { $set: { lastSyncAt: now } });
  }

  if (st.state === "filled") await col.updateOne({ _id: d._id, status: "ACTIVE" }, { $set: { status: "FILLED", updatedAt: now } });
  else if (st.state === "cancelled") {
    await col.updateOne({ _id: d._id, status: "ACTIVE" }, { $set: { status: "CANCELLED", updatedAt: now } });
    await notifyUser(d.userId, autoSellProblem("cancelled", symbol, `An auto-sell order for ${symbol} was cancelled, so that part of the position will not sell by itself.`, d.positionId));
  } else if (st.state === "expired") {
    await col.updateOne({ _id: d._id, status: "ACTIVE" }, { $set: { status: "EXPIRED", updatedAt: now } });
    await notifyUser(d.userId, autoSellProblem("expired", symbol, `An auto-sell order for ${symbol} expired before its price was reached.`, d.positionId));
  }
  return booked;
}

/** Orders for display next to a position. */
export async function autoSellsFor(positionIds: string[]) {
  if (!positionIds.length) return new Map<string, AutoSellOrderDoc[]>();
  const rows = await (await collections.autoSellOrders()).find({ positionId: { $in: positionIds }, status: { $nin: ["SUPERSEDED"] } }).sort({ gainPct: 1 }).toArray();
  const map = new Map<string, AutoSellOrderDoc[]>();
  for (const r of rows) map.set(r.positionId, [...(map.get(r.positionId) ?? []), r]);
  return map;
}
