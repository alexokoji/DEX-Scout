import type { ChainId } from "@/core/types";
import { providers } from "@/core/providers/registry";
import { collections, newId, withUserLock } from "@/lib/db";
import { logEvent } from "@/lib/events";
import { reconcileLiveTrade } from "./trading";

/**
 * Finds open positions that are really over and closes them. Three kinds of evidence, in this order:
 *  1. a sale the wallet sent that the chain has confirmed but that was never booked: settled the normal way (proceeds and
 *     realised P&L recorded), because that is a sale the app made;
 *  2. dust: so little is left (a millionth of what was bought) that it is only a rounding remainder of a sale;
 *  3. the wallet holds none of the token any more, checked on-chain twice a moment apart (a sale made from the wallet app
 *     itself, outside this one). No proceeds are known for those, so the position is closed with no realised P&L change.
 * What it will NOT do: close anything it could not check. An unreachable node reads as "unknown", never as "none left", a
 * position whose wallet or token it can't resolve is left alone, and one that holds fewer tokens than recorded (but not none)
 * is reported, not changed.
 */
export interface Finding {
  positionId: string;
  userId: string;
  symbol: string;
  chain: string;
  amount: number;
  reason: "DUST" | "GONE_FROM_WALLET";
  detail: string;
}
export interface Kept {
  positionId: string;
  symbol: string;
  why: string;
}
export interface CleanupReport {
  /** sales that had confirmed on-chain and were booked now (0 in a dry run, which only counts them) */
  settledTrades: number;
  pendingConfirmable: number;
  checked: number;
  stale: Finding[];
  kept: Kept[];
  closed: number;
}

export interface CleanupOptions {
  apply: boolean;
  /** a position opened this recently isn't checked: a fresh buy's balance may not have reached the node yet */
  minAgeMs?: number;
  /** how long to wait between the two "none left" reads */
  confirmDelayMs?: number;
  now?: Date;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function cleanUpPositions(opts: CleanupOptions): Promise<CleanupReport> {
  const now = opts.now ?? new Date();
  const minAgeMs = opts.minAgeMs ?? 10 * 60_000;
  const confirmDelayMs = opts.confirmDelayMs ?? 2_000;
  const p = providers();
  const trades = await collections.trades();
  const positions = await collections.positions();
  const tokens = await collections.tokens();
  const report: CleanupReport = { settledTrades: 0, pendingConfirmable: 0, checked: 0, stale: [], kept: [], closed: 0 };

  // 1. sales the chain has confirmed that were never booked
  const pending = await trades.find({ status: "PENDING", "transaction.signature": { $ne: null } }).toArray();
  for (const t of pending) {
    const chain = (await tokens.findOne({ _id: t.tokenId }, { projection: { chain: 1 } }))?.chain as ChainId | undefined;
    if (!chain || !t.transaction?.signature) continue;
    const st = await p.dex.getTransactionStatus(chain, t.transaction.signature).catch(() => null);
    if (st?.status !== "CONFIRMED") continue;
    report.pendingConfirmable++;
    if (opts.apply) {
      const r = await reconcileLiveTrade(t._id).catch(() => null);
      if (r?.status === "CONFIRMED") report.settledTrades++;
    }
  }

  // 2 + 3. what is still listed as open
  const open = await positions.find({ status: { $ne: "CLOSED" }, environment: "LIVE" }).toArray();
  const stillPending = new Set((await trades.find({ status: "PENDING", positionId: { $ne: null } }, { projection: { positionId: 1 } }).toArray()).map((t) => t.positionId));
  for (const pos of open) {
    report.checked++;
    const token = await tokens.findOne({ _id: pos.tokenId });
    const symbol = token?.symbol ?? "?";
    const keep = (why: string) => report.kept.push({ positionId: pos._id, symbol, why });
    const found = (reason: Finding["reason"], detail: string) => report.stale.push({ positionId: pos._id, userId: pos.userId, symbol, chain: token?.chain ?? "?", amount: pos.amount, reason, detail });

    if (!(pos.amount > pos.initialAmount * 1e-6)) {
      found("DUST", `${pos.amount} left of ${pos.initialAmount} bought: a rounding remainder, not a holding`);
      continue;
    }
    if (stillPending.has(pos._id)) {
      keep("a sale of it is still waiting to confirm");
      continue;
    }
    if (now.getTime() - pos.openedAt.getTime() < minAgeMs) {
      keep("opened a moment ago; its balance may not have reached the node yet");
      continue;
    }
    if (!token || !pos.walletAddress) {
      keep("no wallet or token recorded for it, so there is nothing to check");
      continue;
    }
    const chain = p.chains[token.chain as ChainId];
    if (!chain?.getTokenBalance) {
      keep("this chain can't report token balances");
      continue;
    }
    const first = await chain.getTokenBalance(pos.walletAddress, token.address);
    if (first === null) {
      keep("the chain could not be read, so it is left alone");
      continue;
    }
    if (first > 0) {
      if (first < pos.amount * (1 - 1e-3)) keep(`the wallet holds ${first} of the ${pos.amount} recorded (part of it was sold elsewhere?): reported, not changed`);
      continue;
    }
    // the wallet holds none: read it again before believing it
    await sleep(confirmDelayMs);
    const second = await chain.getTokenBalance(pos.walletAddress, token.address);
    if (second === 0) found("GONE_FROM_WALLET", `the wallet ${pos.walletAddress.slice(0, 6)}…${pos.walletAddress.slice(-4)} holds none of it (the chain says 0, twice), so it was sold outside the app`);
    else keep(second === null ? "the chain could not be read on the second look, so it is left alone" : "its balance changed between two reads, so it is left alone");
  }

  if (opts.apply) {
    for (const f of report.stale) {
      const done = await closeOne(f, now);
      if (done) report.closed++;
    }
  }
  return report;
}

async function closeOne(f: Finding, now: Date): Promise<boolean> {
  const positions = await collections.positions();
  const events = await collections.positionEvents();
  let closed = false;
  await withUserLock(f.userId, async (session) => {
    const r = await positions.updateOne(
      { _id: f.positionId, status: { $ne: "CLOSED" } },
      { $set: { status: "CLOSED", amount: 0, costBasisUsd: 0, closedAt: now, updatedAt: now } },
      { session },
    );
    if (!r.modifiedCount) return; // someone closed it between the check and now
    closed = true;
    await events.insertOne({ _id: newId(), positionId: f.positionId, type: "CLEANUP_CLOSED", message: `Closed by cleanup: ${f.detail}. No proceeds recorded, realised P&L unchanged.`, data: { reason: f.reason, amount: f.amount }, createdAt: now }, { session });
  });
  if (closed) await logEvent({ type: "POSITION_CLOSED", source: "cleanup", userId: f.userId, message: `Position closed by cleanup: ${f.symbol} (${f.reason})`, data: { positionId: f.positionId } });
  return closed;
}

