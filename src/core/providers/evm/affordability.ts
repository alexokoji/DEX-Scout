/**
 * Can this wallet afford this transaction? Asked of the chain, not estimated here: the node's own gas estimate for the real
 * transaction, from the real wallet, set against the wallet's real balance at the chain's current gas price. Every figure in the
 * answer came from the chain, and so does the verdict. (There is no reserve and no margin: any margin would be a number we made up.)
 *
 * What it can and can't settle:
 *  - a buy (native coin in, no approval): the node estimates the swap itself, so a swap that would revert is caught here, with the
 *    node's own reason, and so is a wallet that can't cover the amount plus the gas;
 *  - a sell (needs an approval first): the swap can't be estimated until the approval is on-chain, so the approval is estimated and
 *    the aggregator's own gas figure for the swap (when it gave one) is added; the wallet checks the swap again when it sends it.
 */
import { CHAINS } from "../../chains";
import type { ChainId } from "../../types";
import type { PreflightResult } from "../interfaces";
import { evmGasPriceWei, evmRpc } from "./evmProviders";

interface Call {
  to: string;
  data: string;
  value?: string;
}
interface EvmPayload {
  chainId: number;
  approval?: Call;
  tx: Call;
  /** the aggregator's own gas figure for the swap (decimal units), when it gave one */
  swapGasUnits?: string;
}

/** Native amount for a message: 0.00123 ETH, three significant digits, never a long run of zeros. */
export function nativeText(wei: bigint, symbol: string): string {
  return `${(Number(wei) / 1e18).toLocaleString("en-US", { maximumSignificantDigits: 3, maximumFractionDigits: 18 })} ${symbol}`;
}

const SLIPPAGE = /too little received|insufficient[_ ]output|slippage|min(?:imum)?[_ ](?:amount|return|out)|price impact|INSUFFICIENT_OUTPUT_AMOUNT|return amount is not enough/i;
const FUNDS = /insufficient funds|exceeds balance|not enough (?:balance|funds)/i;

const estimate = (chain: ChainId, from: string, c: Call): Promise<bigint> =>
  evmRpc<string>(chain, "eth_estimateGas", [{ from, to: c.to, data: c.data, value: c.value ?? "0x0" }], 8_000).then((g) => BigInt(g));

function insufficient(chain: ChainId, balance: bigint, parts: { label: string; wei: bigint }[]): PreflightResult {
  const sym = CHAINS[chain].nativeSymbol;
  const need = parts.reduce((s, p) => s + p.wei, BigInt(0));
  return {
    ok: false,
    kind: "insufficient_native",
    error: `Not enough ${sym}: this needs ${nativeText(need, sym)} (${parts.map((p) => `${nativeText(p.wei, sym)} ${p.label}`).join(" + ")}) and the wallet holds ${nativeText(balance, sym)}.`,
  };
}

export async function preflightEvm(chain: ChainId, unsignedTx: string, user: string): Promise<PreflightResult> {
  let payload: EvmPayload;
  try {
    payload = JSON.parse(unsignedTx) as EvmPayload;
    if (!payload?.tx?.to) return { ok: true };
  } catch {
    return { ok: true };
  }
  const [balance, price] = await Promise.all([evmRpc<string>(chain, "eth_getBalance", [user, "latest"], 6_000).then((h) => BigInt(h), () => null), evmGasPriceWei(chain)]);
  // a node that can't be reached can't answer: the wallet gets the final say, as it always had
  if (balance === null || price === null) return { ok: true };
  const value = BigInt(payload.tx.value || "0x0");
  const sym = CHAINS[chain].nativeSymbol;
  // What the balance alone proves, whatever a node says about gas (nodes word their errors differently, and some don't check funds
  // when estimating): the wallet can't send more than it holds, and a wallet holding none can't pay any fee.
  if (balance < value) return insufficient(chain, balance, [{ label: "to swap", wei: value }]);
  if (balance === BigInt(0)) return { ok: false, kind: "insufficient_native", error: `Not enough ${sym}: the wallet holds none on this chain, so it can't pay the network fee.` };

  if (!payload.approval) {
    let gas: bigint;
    try {
      gas = await estimate(chain, user, payload.tx);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (FUNDS.test(msg)) return insufficient(chain, balance, [{ label: "to swap", wei: value }]);
      if (SLIPPAGE.test(msg)) return { ok: false, kind: "slippage", error: `The price moved more than your slippage tolerance while the swap was being checked (${msg.slice(0, 120)}).` };
      // the node estimated and the swap would revert: say what it said. (A node that just failed to answer is not a revert.)
      if (/revert|execution|VM Exception|out of gas|invalid opcode/i.test(msg)) return { ok: false, kind: "other", error: `The swap would fail on-chain: ${msg.slice(0, 160)}` };
      return { ok: true };
    }
    const fee = gas * price;
    return balance >= value + fee ? { ok: true } : insufficient(chain, balance, [{ label: "to swap", wei: value }, { label: "network fee", wei: fee }]);
  }

  // a sell: the approval first, then the swap
  let approvalGas: bigint;
  try {
    approvalGas = await estimate(chain, user, payload.approval);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (FUNDS.test(msg)) return { ok: false, kind: "insufficient_native", error: `Not enough ${sym} to pay the network fee for the token approval.` };
    return { ok: true };
  }
  const swapGas = (() => {
    try {
      return BigInt(payload.swapGasUnits ?? "0");
    } catch {
      return BigInt(0);
    }
  })();
  const parts = [{ label: "network fee for the approval", wei: approvalGas * price }, ...(swapGas > BigInt(0) ? [{ label: "network fee for the swap", wei: swapGas * price }] : [])];
  const need = parts.reduce((s, p) => s + p.wei, BigInt(0)) + value;
  return balance >= need ? { ok: true } : insufficient(chain, balance, parts);
}

/** For arming auto-sell: can the wallet pay for the one approval? The chain's own estimate against the wallet's balance. */
export async function approvalAffordable(chain: ChainId, user: string, approval: Call): Promise<PreflightResult> {
  const payload: EvmPayload = { chainId: CHAINS[chain].evmChainId ?? 0, approval, tx: approval };
  return preflightEvm(chain, JSON.stringify(payload), user);
}
