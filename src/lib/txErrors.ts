/**
 * What a wallet or RPC says when sending a transaction fails, in words a person can act on. Browser-safe.
 * The original message is kept after the explanation so it can still be reported or searched.
 */
export function explainWalletError(e: unknown): string {
  const err = e as { message?: string; code?: number | string; logs?: string[]; error?: { message?: string; code?: number } } | null;
  const raw = (err?.message || err?.error?.message || (typeof e === "string" ? e : "") || "Unknown wallet error").toString();
  const logs = Array.isArray(err?.logs) ? err!.logs!.join("\n") : "";
  const text = `${raw}\n${logs}`;
  const code = err?.code ?? err?.error?.code;

  if (code === 4001 || code === "ACTION_REJECTED" || /user rejected|rejected the request|user denied|declined|cancell?ed/i.test(raw)) return "You declined the transaction in your wallet.";
  if (/"Custom":\s*6001\b|0x1771\b|slippage/i.test(text)) return `Rejected in the wallet's simulation: the price moved beyond your slippage tolerance. Raise slippage a little (3% is typical for small tokens) and try again. (${short(raw)})`;
  const lam = text.match(/insufficient lamports (\d+), need (\d+)/i);
  if (lam) return `Not enough SOL: ${(Number(lam[1]) / 1e9).toFixed(4)} SOL available, ${(Number(lam[2]) / 1e9).toFixed(4)} SOL needed, plus network fees and the token-account deposit. Buy a smaller amount or add some SOL.`;
  if (/insufficient funds for rent|InsufficientFundsForRent|insufficient funds for fee|InsufficientFundsForFee|insufficient funds/i.test(text)) return `Not enough funds left to pay fees (and, on Solana, the small token-account deposit) after the swap. Buy a smaller amount or add a little of the chain's native coin. (${short(raw)})`;
  if (/Blockhash not found|BlockhashNotFound|block height exceeded|expired/i.test(text)) return "The transaction expired before it was sent (the wallet took too long or the network lagged). Try again.";
  if (/simulation failed|simulate/i.test(text)) return `The wallet's simulation says this transaction would fail. ${short(lastLog(logs) || raw)}`;
  return short(raw, 200);
}

const short = (s: string, n = 160) => (s.length > n ? `${s.slice(0, n)}…` : s);
const lastLog = (logs: string) => logs.split("\n").filter(Boolean).slice(-2).join(" | ");
