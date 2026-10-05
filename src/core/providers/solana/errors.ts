/**
 * Turn a failed Solana transaction simulation into something a person can act on. Forms below were captured from real
 * simulations of Jupiter swaps: slippage is `{"InstructionError":[n,{"Custom":6001}]}`, a wallet short of SOL is
 * `{"Custom":1}` with the log "Transfer: insufficient lamports X, need Y".
 */
export type SimFailureKind = "slippage" | "insufficient_sol" | "insufficient_token" | "no_sol_account" | "blockhash" | "other";

export interface SimFailure {
  kind: SimFailureKind;
  message: string;
}

const sol = (lamports: number) => (lamports / 1e9).toLocaleString("en-US", { maximumFractionDigits: 4 });

export function explainSolanaSimulation(err: unknown, logs: readonly string[] = []): SimFailure {
  const errText = typeof err === "string" ? err : JSON.stringify(err ?? "");
  const text = `${errText}\n${logs.join("\n")}`;

  if (/"Custom":\s*6001\b|0x1771\b|SlippageToleranceExceeded|slippage tolerance/i.test(text)) {
    return { kind: "slippage", message: "The price moved more than your slippage tolerance while the swap was being checked (common for small, fast-moving tokens)." };
  }
  const lamports = text.match(/insufficient lamports (\d+), need (\d+)/i);
  if (lamports) {
    return { kind: "insufficient_sol", message: `Not enough SOL: the wallet has ${sol(Number(lamports[1]))} SOL available but this swap needs ${sol(Number(lamports[2]))} SOL, plus a little for network fees and for creating the token account.` };
  }
  if (/InsufficientFundsForRent|insufficient funds for rent|InsufficientFundsForFee|insufficient funds for fee/i.test(text)) {
    return { kind: "insufficient_sol", message: "Not enough SOL left over after the swap to pay network fees and the small deposit for the new token account. Buy a smaller amount, or add a little SOL." };
  }
  if (/AccountNotFound|found no record of a prior credit/i.test(text)) {
    return { kind: "no_sol_account", message: "This wallet has no SOL on Solana to pay the network fee. Add a little SOL and try again." };
  }
  if (/BlockhashNotFound|Blockhash not found/i.test(text)) {
    return { kind: "blockhash", message: "The Solana network node was a few seconds behind. Just try again." };
  }
  if (/insufficient funds/i.test(text) && /Token(keg|zQd)/i.test(text)) {
    return { kind: "insufficient_token", message: "The wallet does not hold enough of this token to sell that amount." };
  }
  const code = text.match(/"Custom":\s*(\d+)/)?.[1];  return { kind: "other", message: `The swap would fail on-chain${code ? ` (program error ${code})` : ""}${errText && errText !== '""' ? `: ${errText.slice(0, 160)}` : ""}.` };
}

/**
 * The same errors, but for a swap that already ran and failed on the chain (the wallet signed and sent it), so the wording is
 * past tense and says what it cost. A failed Solana transaction still pays its network fee; nothing else leaves the wallet.
 */
export function explainSolanaOnChainFailure(err: unknown): SimFailure {
  const f = explainSolanaSimulation(err);
  switch (f.kind) {
    case "slippage":
      return { kind: "slippage", message: "The price moved past your slippage limit before the swap was confirmed, so the chain cancelled it. Only the network fee was spent. Try again, with a higher slippage if this token is moving fast" };
    case "insufficient_sol":
      return { kind: f.kind, message: "The wallet ran short of SOL when the swap executed, so the chain cancelled it. Only the network fee was spent. Buy a smaller amount or add a little SOL" };
    case "blockhash":
      return { kind: f.kind, message: "The swap expired before the network processed it. Nothing was swapped. Try again" };
    default:
      return { kind: f.kind, message: f.message.replace(/^The swap would fail on-chain/, "The swap failed on-chain").replace(/\.$/, "") };
  }
}
