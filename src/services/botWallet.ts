import { PublicKey } from "@solana/web3.js";
import { CHAIN_IDS, CHAINS } from "@/core/chains";
import { open, parseMasterKey, seal } from "@/core/botwallet/crypto";
import { evmAccount, generateWallet, secretForExport, solanaKeypair, type Family } from "@/core/botwallet/keys";
import { providers } from "@/core/providers/registry";
import { evmRpc, evmGasPriceWei } from "@/core/providers/evm/evmProviders";
import { sendEvmRaw, signEvmCall } from "@/core/providers/evm/botSigner";
import { solanaTry } from "@/core/providers/solana/solanaProviders";
import { closableAccounts, closeTransactions, emptyTokenAccounts } from "@/core/providers/solana/reclaim";
import { buildSolTransfer, signSolanaTransaction } from "@/core/providers/solana/botSigner";
import type { ChainId } from "@/core/types";
import { verifyPassword } from "@/lib/auth";
import { collections, newId } from "@/lib/db";
import { env } from "@/lib/env";
import { logEvent } from "@/lib/events";
import type { BotWalletDoc } from "@/lib/models";
import { TradeError } from "./errors";
import { linkedWallets, walletFamilyOf } from "./walletResolve";

/**
 * The bot wallet: a wallet whose key this server holds, so the bot can trade without a signature from the user each time. It is the one
 * place in the app that holds a key, so it is built to hold as little as possible: the user funds it with only what they accept to risk,
 * its secret is sealed at rest with the operator's master key, it can be emptied only to the user's own verified wallet, and the key can
 * be exported (after a password check) so the money never depends on this app staying up.
 */

const aad = (userId: string, family: Family, address: string) => `${userId}:${family}:${address}`;

/** True when the operator has set a usable master key. Without it no bot wallet can be created or opened. */
export function botWalletsConfigured(): boolean {
  try {
    parseMasterKey(env().BOT_WALLET_KEY);
    return true;
  } catch {
    return false;
  }
}

const masterKey = () => {
  try {
    return parseMasterKey(env().BOT_WALLET_KEY);
  } catch (e) {
    throw new TradeError(`Unattended trading is not set up on this server: ${e instanceof Error ? e.message : "no master key"}`, 503);
  }
};

export async function getBotWallet(userId: string, family: Family): Promise<BotWalletDoc | null> {
  return (await collections.botWallets()).findOne({ userId, family });
}

/** The user's bot wallet for this family, created (once) if it doesn't exist yet. */
export async function ensureBotWallet(userId: string, family: Family): Promise<BotWalletDoc> {
  const existing = await getBotWallet(userId, family);
  if (existing) return existing;
  const key = masterKey();
  const w = generateWallet(family);
  const doc: BotWalletDoc = { _id: newId(), userId, family, address: w.address, sealed: seal(w.secret, key, aad(userId, family, w.address)), createdAt: new Date(), exportedAt: null };
  try {
    await (await collections.botWallets()).insertOne(doc);
  } catch (err) {
    // a concurrent request created it first (unique index on user + family): use that one, drop this key
    const raced = await getBotWallet(userId, family);
    if (raced) return raced;
    throw err;
  }
  await logEvent({ type: "SETTINGS_UPDATED", source: "botwallet", userId, message: `Bot wallet created (${family}): ${w.address}`, data: { family, address: w.address } });
  return doc;
}

/** The bot wallet's address for the chain's family, or null when there isn't one. */
export async function botAddressFor(userId: string, chain: string): Promise<string | null> {
  return (await getBotWallet(userId, walletFamilyOf(chain)))?.address ?? null;
}

/** Opens a bot wallet's secret. Only the signing paths in this app call this; nothing here returns it to a client. */
export function openSecret(doc: BotWalletDoc): Buffer {
  return open(doc.sealed, masterKey(), aad(doc.userId, doc.family, doc.address));
}

export async function botSolanaKeypair(userId: string) {
  const doc = await getBotWallet(userId, "solana");
  if (!doc) throw new TradeError("No Solana bot wallet", 409);
  return solanaKeypair(openSecret(doc));
}

export async function botEvmAccount(userId: string) {
  const doc = await getBotWallet(userId, "evm");
  if (!doc) throw new TradeError("No EVM bot wallet", 409);
  return evmAccount(openSecret(doc));
}

/** What the bot wallet holds on each chain of its family, in the chain's own coin and in USD: what the user has funded it with. */
export async function botWalletOverview(userId: string) {
  const out: { family: Family; address: string; createdAt: Date; exportedAt: Date | null; balances: { chain: ChainId; name: string; symbol: string; amount: number | null; usd: number | null }[] }[] = [];
  for (const family of ["solana", "evm"] as const) {
    const w = await getBotWallet(userId, family);
    if (!w) continue;
    const chains = CHAIN_IDS.filter((c) => (family === "evm" ? CHAINS[c].family === "evm" : CHAINS[c].family === "svm"));
    const balances = await Promise.all(
      chains.map(async (c) => {
        const a = providers().chains[c];
        const [amount, px] = await Promise.all([a.getNativeBalance(w.address).catch(() => null), a.nativeUsdPrice().catch(() => 0)]);
        return { chain: c, name: CHAINS[c].name, symbol: CHAINS[c].nativeSymbol, amount, usd: amount === null ? null : amount * px };
      }),
    );
    out.push({ family, address: w.address, createdAt: w.createdAt, exportedAt: w.exportedAt, balances });
  }
  return { configured: botWalletsConfigured(), wallets: out };
}

/** Where a withdrawal goes: the user's own verified wallet of this family (a specific one if named, else the most recently verified). Never any other address. */
async function destination(userId: string, family: Family, to?: string): Promise<string> {
  const linked = await linkedWallets(userId, family);
  const hit = to ? linked.find((w) => (family === "evm" ? w.address.toLowerCase() === to.toLowerCase() : w.address === to)) : linked[0];
  if (!hit) throw new TradeError(to ? "That address isn't one of your verified wallets: withdrawals only go to a wallet you've verified" : `Verify a ${family === "evm" ? "EVM" : "Solana"} wallet first: withdrawals only go to your own verified wallet`, 409);
  return hit.address;
}

/**
 * Sends the bot wallet's whole balance of the chain's own coin (less the fee to send it) to the user's verified wallet. Tokens it holds are
 * not moved: open positions are sold by the bot at their targets, or can be sold now from the Positions page.
 */
export async function withdrawNative(userId: string, chain: ChainId, to?: string): Promise<{ signature: string; to: string; amount: number; symbol: string }> {
  const family = walletFamilyOf(chain);
  const w = await getBotWallet(userId, family);
  if (!w) throw new TradeError("There is no bot wallet to withdraw from", 409);
  const dest = await destination(userId, family, to);
  const symbol = CHAINS[chain].nativeSymbol;

  if (family === "solana") {
    const kp = await botSolanaKeypair(userId);
    const from = kp.publicKey;
    const { lamports, fee, blockhash } = await solanaTry(async (c) => {
      const [bal, bh] = await Promise.all([c.getBalance(from, "confirmed"), c.getLatestBlockhash()]);
      const probe = buildSolTransfer(from, new PublicKey(dest), 1, bh.blockhash);
      const f = (await c.getFeeForMessage(probe.message)).value;
      if (f == null) throw new Error("The network fee could not be read");
      return { lamports: bal, fee: f, blockhash: bh.blockhash };
    }, 10_000);
    const send = lamports - fee;
    if (send <= 0) throw new TradeError("The bot wallet holds less than the network fee, so there is nothing to withdraw", 409);
    const signed = signSolanaTransaction(Buffer.from(buildSolTransfer(from, new PublicKey(dest), send, blockhash).serialize()).toString("base64"), kp);
    const signature = await solanaTry((c) => c.sendRawTransaction(Buffer.from(signed.signedB64, "base64"), { skipPreflight: false, maxRetries: 3 }), 15_000);
    await logEvent({ type: "TRADE_EXECUTED", source: "botwallet", userId, message: `Bot wallet withdrawal: ${(send / 1e9).toFixed(6)} SOL to ${dest}`, data: { signature, to: dest } });
    return { signature, to: dest, amount: send / 1e9, symbol };
  }

  const account = await botEvmAccount(userId);
  const balance = BigInt(await evmRpc<string>(chain, "eth_getBalance", [account.address, "latest"], 8_000));
  const price = await evmGasPriceWei(chain);
  if (price === null) throw new TradeError("The chain's gas price could not be read right now", 503);
  const gas = BigInt(await evmRpc<string>(chain, "eth_estimateGas", [{ from: account.address, to: dest, value: "0x0" }], 8_000));
  const fee = (gas * BigInt(6) * price) / BigInt(5); // the same headroom signEvmCall puts on its estimate
  const send = balance - fee;
  if (send <= BigInt(0)) throw new TradeError(`The bot wallet holds less ${symbol} than the network fee, so there is nothing to withdraw on ${CHAINS[chain].name}`, 409);
  const signed = await signEvmCall(chain, account, { to: dest, data: "0x", value: "0x" + send.toString(16) });
  const hash = await sendEvmRaw(chain, signed.raw);
  await logEvent({ type: "TRADE_EXECUTED", source: "botwallet", userId, message: `Bot wallet withdrawal on ${CHAINS[chain].name}: ${Number(send) / 1e18} ${symbol} to ${dest}`, data: { hash, to: dest } });
  return { signature: hash, to: dest, amount: Number(send) / 1e18, symbol };
}

/** The bot wallet's key, for the user to import into a wallet app (so the money never depends on this app). Needs the account password. */
export async function exportBotKey(userId: string, family: Family, password: string): Promise<{ address: string; secret: string; format: string }> {
  const user = await (await collections.users()).findOne({ _id: userId });
  if (!user || !(await verifyPassword(password, user.passwordHash))) throw new TradeError("That password is not right", 403);
  const w = await getBotWallet(userId, family);
  if (!w) throw new TradeError("There is no bot wallet for that address family", 404);
  await (await collections.botWallets()).updateOne({ _id: w._id }, { $set: { exportedAt: new Date() } });
  await logEvent({ type: "SETTINGS_UPDATED", source: "botwallet", userId, level: "WARN", message: `Bot wallet key exported (${family})`, data: { family, address: w.address } });
  return { address: w.address, secret: secretForExport(family, openSecret(w)), format: family === "evm" ? "EVM private key (hex)" : "Solana secret key (base58)" };
}

/**
 * Solana: every token the bot buys opens a token account that locks a deposit, and selling it leaves the empty account (and the deposit)
 * behind. For a bot that trades many tokens that adds up to more than it earns, so once a position of the bot wallet has closed, the
 * empty accounts are closed by the bot itself and the deposits come back. Cheap when there is nothing to do: it looks only when a bot
 * position has closed since the last time.
 */
export async function sweepBotDeposits(userId: string): Promise<{ closed: number; lamports: number }> {
  const w = await getBotWallet(userId, "solana");
  if (!w) return { closed: 0, lamports: 0 };
  const since = w.sweptAt ?? w.createdAt;
  if (!(await (await collections.positions()).countDocuments({ userId, walletAddress: w.address, status: "CLOSED", closedAt: { $gt: since } }))) return { closed: 0, lamports: 0 };
  const startedAt = new Date();
  const accounts = await closableAccounts(w.address, await emptyTokenAccounts(w.address));
  if (accounts.length) {
    const kp = await botSolanaKeypair(userId);
    for (const t of await closeTransactions(w.address, accounts)) {
      const signed = signSolanaTransaction(t.transaction, kp);
      await solanaTry((c) => c.sendRawTransaction(Buffer.from(signed.signedB64, "base64"), { skipPreflight: false, maxRetries: 3 }), 15_000);
    }
    await logEvent({ type: "TRADE_EXECUTED", source: "botwallet", userId, message: `Bot wallet closed ${accounts.length} empty token account(s) and got back ${(accounts.reduce((s, a) => s + a.lamports, 0) / 1e9).toFixed(6)} SOL of deposits`, data: { accounts: accounts.map((a) => a.address) } });
  }
  await (await collections.botWallets()).updateOne({ _id: w._id }, { $set: { sweptAt: startedAt } });
  return { closed: accounts.length, lamports: accounts.reduce((s, a) => s + a.lamports, 0) };
}
