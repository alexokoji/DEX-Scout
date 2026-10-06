/**
 * Jupiter trigger (limit) orders for Solana auto-sell, v1 on lite-api (keyless at the time of writing). Creating an order
 * returns an UNSIGNED transaction that escrows the tokens in Jupiter's program; the user signs it once, and keepers fill
 * it when the price is reached. The user can always cancel to get the tokens back.
 *
 * Verified live: createOrder (keyless, min order about $5), and the real shape of getTriggerOrders for open, completed
 * (single and multiple fills) and cancelled orders. NOT verified: cancelOrder's success response (no real order was
 * available to cancel), so it is parsed defensively.
 */
const BASE = "https://lite-api.jup.ag/trigger/v1";
/**
 * Jupiter's own rule, from its API ("Order size must be at least 5 USD"), tested live: the order's size is the larger of what
 * the tokens are worth now and what it pays at its target price, and in practice the edge sat a little under $5 (an order
 * measured $4.90 was accepted, $4.84 refused). 3% above $5 keeps clear of that edge and of price moves between our check and
 * the order being created.
 */
export const JUP_MIN_ORDER_USD = 5.15;
export const WSOL = "So11111111111111111111111111111111111111112";
/** Jupiter keeps about 0.8% of the output on fills (seen on real fills); grossed into the limit so the user nets the target. */
export const JUP_FEE_FRACTION = 0.01;

async function jup<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, { ...init, signal: AbortSignal.timeout(15_000) });
  const text = await res.text();
  let body: unknown = text;
  try {
    body = JSON.parse(text);
  } catch {
    /* text */
  }
  if (!res.ok) throw new Error((body as { error?: string })?.error ?? `Jupiter HTTP ${res.status}`);
  return body as T;
}

export async function createJupiterOrder(args: { maker: string; inputMint: string; makingRaw: bigint; takingRaw: bigint }): Promise<{ order: string; requestId: string; transaction: string }> {
  const r = await jup<{ order?: string; requestId?: string; transaction?: string; error?: string }>("/createOrder", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ inputMint: args.inputMint, outputMint: WSOL, maker: args.maker, payer: args.maker, params: { makingAmount: args.makingRaw.toString(), takingAmount: args.takingRaw.toString() }, computeUnitPrice: "auto" }),
  });
  if (!r.order || !r.transaction || !r.requestId) throw new Error(r.error ?? "Jupiter returned no order");
  return { order: r.order, requestId: r.requestId, transaction: r.transaction };
}

/** Unsigned cancellation transaction that returns the escrowed tokens to the maker. */
export async function cancelJupiterOrder(maker: string, order: string): Promise<string> {
  const r = await jup<{ transaction?: string; tx?: string }>("/cancelOrder", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ maker, order, computeUnitPrice: "auto" }) });
  const tx = r.transaction ?? r.tx;
  if (!tx) throw new Error("Jupiter returned no cancellation transaction");
  return tx;
}

export interface JupTrade {
  action?: string;
  rawInputAmount?: string;
  rawOutputAmount?: string;
  rawFeeAmount?: string;
  feeMint?: string;
  outputMint?: string;
  txId?: string;
}
export interface JupOrder {
  orderKey: string;
  status: string; // Open | Completed | Cancelled | ...
  rawMakingAmount?: string;
  rawRemainingMakingAmount?: string;
  trades?: JupTrade[];
  closeTx?: string | null;
}

/** Find one order across the user's active and history lists. null = not listed (yet). */
export async function getJupiterOrder(user: string, orderKey: string): Promise<JupOrder | null> {
  for (const orderStatus of ["active", "history"] as const) {
    for (let page = 1; page <= 3; page++) {
      const r = await jup<{ orders?: JupOrder[]; totalPages?: number }>(`/getTriggerOrders?user=${user}&orderStatus=${orderStatus}&page=${page}`);
      const hit = (r.orders ?? []).find((o) => o.orderKey === orderKey);
      if (hit) return hit;
      if (page >= (r.totalPages ?? 0)) break;
    }
  }
  return null;
}

/** Totals actually filled so far: tokens sold, and the SOL received after Jupiter's fee. */
export function jupiterFills(o: JupOrder): { sellRaw: bigint; buyRaw: bigint; txIds: string[] } {
  let sell = BigInt(0);
  let buy = BigInt(0);
  const txIds: string[] = [];
  for (const t of o.trades ?? []) {
    if (t.action !== "Fill") continue;
    sell += BigInt(t.rawInputAmount ?? "0");
    const out = BigInt(t.rawOutputAmount ?? "0");
    const fee = !t.feeMint || t.feeMint === (t.outputMint ?? WSOL) ? BigInt(t.rawFeeAmount ?? "0") : BigInt(0);
    buy += out > fee ? out - fee : BigInt(0);
    if (t.txId) txIds.push(t.txId);
  }
  return { sellRaw: sell, buyRaw: buy, txIds };
}
