/**
 * The bot wallet is the one place the app holds a key, so the pieces that hold and use it are pinned hard: the key is sealed and only the
 * right master key (and the right wallet) opens it, what is generated imports into a wallet app as the same address, and what is signed is
 * signed by that wallet and verifies. No network: EVM chain reads are stubbed.
 */
import { Keypair, PublicKey } from "@solana/web3.js";
import bs58 from "bs58";
import nacl from "tweetnacl";
import { keccak256, recoverTransactionAddress, parseTransaction } from "viem";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/core/providers/evm/evmProviders", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/core/providers/evm/evmProviders")>()),
  evmGasPriceWei: vi.fn(async () => BigInt(2_000_000_000)),
  evmRpc: vi.fn(async (_chain: string, method: string) => {
    if (method === "eth_getTransactionCount") return "0x7";
    if (method === "eth_estimateGas") return "0x" + (100_000).toString(16);
    throw new Error("unexpected rpc " + method);
  }),
}));

import { open, parseMasterKey, seal } from "@/core/botwallet/crypto";
import { evmAccount, generateWallet, secretForExport, solanaKeypair } from "@/core/botwallet/keys";
import { signEvmCall } from "@/core/providers/evm/botSigner";
import { buildSolTransfer, signSolanaTransaction } from "@/core/providers/solana/botSigner";
import { scalpEconomics } from "@/core/trading/scalp";

const MASTER = Buffer.alloc(32, 7).toString("base64");

describe("sealing a secret", () => {
  const key = parseMasterKey(MASTER);
  const secret = Buffer.from("a secret key");
  it("opens with the right key for the right wallet, and the sealed form isn't the secret", () => {
    const s = seal(secret, key, "user:solana:addr");
    expect(open(s, key, "user:solana:addr").equals(secret)).toBe(true);
    expect(s.ciphertext).not.toContain(secret.toString("base64"));
    expect(Buffer.from(s.ciphertext, "base64").includes(secret)).toBe(false);
  });
  it("a different master key, a different wallet, or an altered value does not open it", () => {
    const s = seal(secret, key, "user:solana:addr");
    expect(() => open(s, parseMasterKey(Buffer.alloc(32, 9).toString("base64")), "user:solana:addr")).toThrow();
    expect(() => open(s, key, "other-user:solana:addr")).toThrow(); // bound to its owner and address: copied onto another record it won't open
    const tampered = { ...s, ciphertext: Buffer.from(Buffer.from(s.ciphertext, "base64").map((b, i) => (i === 0 ? b ^ 1 : b))).toString("base64") };
    expect(() => open(tampered, key, "user:solana:addr")).toThrow();
  });
  it("every sealing uses its own nonce", () => {
    expect(seal(secret, key, "a").iv).not.toBe(seal(secret, key, "a").iv);
  });
  it("a master key that is missing or the wrong size is refused, saying so", () => {
    expect(() => parseMasterKey(undefined)).toThrow(/not set/);
    expect(() => parseMasterKey(Buffer.alloc(16).toString("base64"))).toThrow(/32 bytes/);
  });
});

describe("generated wallets import as the same address", () => {
  it("Solana: the secret is the 64-byte key, exported as base58, and gives back the address", () => {
    const w = generateWallet("solana");
    expect(solanaKeypair(w.secret).publicKey.toBase58()).toBe(w.address);
    const exported = secretForExport("solana", w.secret);
    expect(Keypair.fromSecretKey(bs58.decode(exported)).publicKey.toBase58()).toBe(w.address);
  });
  it("EVM: the secret is the hex key and gives back the address", () => {
    const w = generateWallet("evm");
    expect(evmAccount(w.secret).address).toBe(w.address);
    expect(secretForExport("evm", w.secret)).toMatch(/^0x[0-9a-f]{64}$/);
  });
  it("two wallets are never the same", () => {
    expect(generateWallet("solana").address).not.toBe(generateWallet("solana").address);
  });
});

describe("Solana signing", () => {
  const kp = Keypair.generate();
  const unsigned = (payer: Keypair) => Buffer.from(buildSolTransfer(payer.publicKey, new PublicKey(Keypair.generate().publicKey), 1000, bs58.encode(Buffer.alloc(32, 3))).serialize()).toString("base64");

  it("signs with the wallet's key: the signature verifies, and the id returned is that signature", () => {
    const { signedB64, signature } = signSolanaTransaction(unsigned(kp), kp);
    const raw = Buffer.from(signedB64, "base64");
    // a v0 transaction: [signature count][64-byte signatures][message]
    const sig = raw.subarray(1, 65);
    const message = raw.subarray(65);
    expect(nacl.sign.detached.verify(message, sig, kp.publicKey.toBytes())).toBe(true);
    expect(signature).toBe(bs58.encode(sig));
  });
  it("refuses a transaction the wallet isn't the fee payer of", () => {
    const other = Keypair.generate();
    expect(() => signSolanaTransaction(unsigned(other), kp)).toThrow(/not paid for by the bot wallet/);
  });
});

describe("EVM signing", () => {
  const account = evmAccount(generateWallet("evm").secret);
  const call = { to: "0x" + "ab".repeat(20), data: "0x1234", value: "0x10" };

  it("signs a transaction that recovers to the wallet, with everything taken from the chain", async () => {
    const s = await signEvmCall("base", account, call);
    expect(await recoverTransactionAddress({ serializedTransaction: s.raw as never })).toBe(account.address);
    expect(s.hash).toBe(keccak256(s.raw)); // known before it is sent, so it can be recorded first
    const tx = parseTransaction(s.raw);
    expect(tx.nonce).toBe(7); // the node's pending count
    expect(tx.gasPrice).toBe(BigInt(2_000_000_000)); // the node's gas price
    expect(tx.value).toBe(BigInt(16));
    expect(tx.gas).toBe(BigInt(120_000)); // the node's estimate (100,000) plus 20% headroom
    expect(s.maxFeeWei).toBe(BigInt(120_000) * BigInt(2_000_000_000));
  });
  it("never goes below the aggregator's own gas figure when it gave one", async () => {
    const s = await signEvmCall("base", account, call, { gasFloor: BigInt(500_000) });
    expect(parseTransaction(s.raw).gas).toBe(BigInt(500_000));
  });
});

describe("does a scalp pay for itself?", () => {
  const cheap = { networkFeeUsd: 0.001, priorityFeeUsd: 0, platformFeeUsd: 0, priceImpactPct: 0.05 };
  it("a few percent on a Solana-sized fee pays", () => {
    const e = scalpEconomics({ amountUsd: 10, firstTargetGainPct: 3, firstTargetSellPct: 50, quote: cheap });
    expect(e.pays).toBe(true);
    expect(e.firstTargetProfitUsd).toBeCloseTo(0.15, 10);
    expect(e.roundTripCostUsd).toBeCloseTo(0.002 + 5 * 0.0005 * 2, 10);
  });
  it("the same target on a dear chain is all fees, and says what gain would cover them", () => {
    const e = scalpEconomics({ amountUsd: 10, firstTargetGainPct: 3, firstTargetSellPct: 50, quote: { ...cheap, networkFeeUsd: 0.5 } });
    expect(e.pays).toBe(false);
    expect(e.breakEvenGainPct).toBeGreaterThan(3);
  });
  it("selling a smaller share at the first target earns less against the same fees", () => {
    const full = scalpEconomics({ amountUsd: 10, firstTargetGainPct: 3, firstTargetSellPct: 100, quote: cheap });
    const quarter = scalpEconomics({ amountUsd: 10, firstTargetGainPct: 3, firstTargetSellPct: 25, quote: cheap });
    expect(quarter.firstTargetProfitUsd).toBeLessThan(full.firstTargetProfitUsd);
  });
});
