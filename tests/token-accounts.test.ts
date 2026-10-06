/**
 * "I can't have $0.47, trade $0.10 and end up with $0.37 after a sale that made a profit." What actually happened is that the chain
 * locks a deposit in the token account a first buy opens, and a sale doesn't close it. These pin how that is read off transactions, how
 * the deposit is handed back, and how the wallet's own result is put beside the price-based profit. The addresses and amounts in the
 * first block are from the real transactions that raised the question.
 */
import { PublicKey, VersionedTransaction } from "@solana/web3.js";
import { describe, expect, it } from "vitest";
import { associatedTokenAddress, buildCloseTransaction, closeAccountInstruction, closedAccounts, depositChange, TOKEN_2022_PROGRAM, TOKEN_PROGRAM } from "@/core/providers/solana/tokenAccounts";
import { walletResult, type WalletChange } from "@/core/trading/walletResult";

const OWNER = "74CB2pZaCa3gG9eGZyrwLpgrfWgXnzPxGmY7VRmAFuXR";
const MINT = "CTPoyCwkjMvoJwU4xvZZqoD8tiYk6yDchySiN5gGpump";

describe("token accounts", () => {
  it("derives the account a wallet holds a token in, the way the chain does (checked against a real wallet)", () => {
    expect(associatedTokenAddress(new PublicKey(OWNER), new PublicKey(MINT), TOKEN_2022_PROGRAM).toBase58()).toBe("BYhawwEuVFx4pAXi4V7ou1Pzzu3knUsfNFPj6KChP34Y");
  });

  it("closing an account is the token program's close instruction: the account, where the deposit goes, and the owner's authority", () => {
    const account = new PublicKey("BYhawwEuVFx4pAXi4V7ou1Pzzu3knUsfNFPj6KChP34Y");
    const owner = new PublicKey(OWNER);
    const ix = closeAccountInstruction(account, owner, TOKEN_2022_PROGRAM);
    expect(ix.programId.equals(TOKEN_2022_PROGRAM)).toBe(true);
    expect([...ix.data]).toEqual([9]);
    expect(ix.keys.map((k) => [k.pubkey.toBase58(), k.isSigner, k.isWritable])).toEqual([
      [account.toBase58(), false, true],
      [OWNER, false, true],
      [OWNER, true, false],
    ]);
  });

  it("one transaction closes several accounts, paid and signed by the wallet that owns them", () => {
    const accounts = [
      { address: "BYhawwEuVFx4pAXi4V7ou1Pzzu3knUsfNFPj6KChP34Y", mint: MINT, program: TOKEN_2022_PROGRAM.toBase58(), lamports: 1_513_840 },
      { address: "7qwRSHmgmfvNn5Ws19dXhiZbmaMEQ83CSJVfvWFo1SXM", mint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", program: TOKEN_PROGRAM.toBase58(), lamports: 1_488_440 },
    ];
    const tx = buildCloseTransaction(new PublicKey(OWNER), accounts, "11111111111111111111111111111111");
    const back = VersionedTransaction.deserialize(tx.serialize());
    expect(back.message.compiledInstructions).toHaveLength(2);
    expect(back.message.staticAccountKeys[0].toBase58()).toBe(OWNER); // the fee payer and the only signer
    expect(back.message.header.numRequiredSignatures).toBe(1);
  });
});

describe("what a transaction did to the wallet's token-account deposits", () => {
  // account indexes: 0 = the wallet, 5 = its token account for the token, 9 = a pool's account
  const tb = (accountIndex: number, owner: string, mint = MINT) => ({ accountIndex, owner, mint });
  const lamports = (o: Record<number, number>, n = 12) => Array.from({ length: n }, (_, i) => o[i] ?? 0);

  it("a first buy opens the account and locks its deposit", () => {
    const meta = { preBalances: lamports({ 0: 4_000_000, 9: 7_000_000 }), postBalances: lamports({ 0: 1_644_000, 5: 1_513_840, 9: 7_840_000 }), preTokenBalances: [tb(9, "pool")], postTokenBalances: [tb(5, OWNER), tb(9, "pool")] };
    expect(depositChange(meta, OWNER)).toEqual({ locked: 1_513_840, returned: 0 });
  });

  it("a sale that leaves the account open (the real one) moves no deposit: that is why it stayed locked", () => {
    const meta = { preBalances: lamports({ 0: 1_000_000, 5: 1_513_840 }), postBalances: lamports({ 0: 1_884_851, 5: 1_513_840 }), preTokenBalances: [tb(5, OWNER)], postTokenBalances: [tb(5, OWNER)] };
    expect(depositChange(meta, OWNER)).toEqual({ locked: 0, returned: 0 });
  });

  it("closing the account returns the deposit, and says which token's it was", () => {
    const meta = { preBalances: lamports({ 0: 1_000_000, 5: 1_513_840 }), postBalances: lamports({ 0: 2_507_000 }), preTokenBalances: [tb(5, OWNER)], postTokenBalances: [] };
    expect(depositChange(meta, OWNER)).toEqual({ locked: 0, returned: 1_513_840 });
    expect(closedAccounts(meta, OWNER)).toEqual([{ mint: MINT, lamports: 1_513_840 }]);
  });

  it("a temporary account opened and closed inside one swap, or one belonging to someone else, is not the wallet's deposit", () => {
    const temp = { preBalances: lamports({ 0: 5_000_000 }), postBalances: lamports({ 0: 4_990_000 }), preTokenBalances: [], postTokenBalances: [tb(7, OWNER, "So11111111111111111111111111111111111111112")] };
    expect(depositChange(temp, OWNER)).toEqual({ locked: 0, returned: 0 });
    const other = { preBalances: lamports({ 9: 0 }), postBalances: lamports({ 9: 2_039_280 }), preTokenBalances: [], postTokenBalances: [tb(9, "someone-else")] };
    expect(depositChange(other, OWNER)).toEqual({ locked: 0, returned: 0 });
    expect(closedAccounts({ preBalances: lamports({ 5: 1_513_840 }), postBalances: lamports({}), preTokenBalances: [tb(5, "someone-else")], postTokenBalances: [] }, OWNER)).toEqual([]);
  });
});

describe("the wallet's own result beside the price-based profit", () => {
  const SOL = 120.32;
  const buy: WalletChange = { nativeDelta: -0.002356, feeNative: 0.000006, depositNative: 0.00151384, nativeUsd: SOL }; // the swap, the fee and the deposit all left the wallet
  const sell: WalletChange = { nativeDelta: 0.000884851, feeNative: 0.000005728, depositNative: 0, nativeUsd: SOL }; // the swap paid out, less the fee

  it("a round trip that made money on price still leaves the wallet lower while the deposit is held, and the difference is the deposit", () => {
    const r = walletResult([{ walletChange: buy }, { walletChange: sell }])!;
    expect(r.changeUsd).toBeLessThan(0); // the wallet is down...
    expect(r.swapNetUsd).toBeGreaterThan(0); // ...although the swaps themselves made money
    expect(r.depositHeldUsd).toBeCloseTo(0.00151384 * SOL, 8);
    // the three parts add up to the wallet's total: swaps - fees - deposit held
    expect(r.swapNetUsd - r.feesUsd - r.depositHeldUsd).toBeCloseTo(r.changeUsd, 10);
  });

  it("once the deposit is reclaimed, it stops counting as lost", () => {
    const refundUsd = 0.00151384 * SOL;
    const r = walletResult([{ walletChange: buy }, { walletChange: sell }], refundUsd)!;
    expect(r.depositHeldUsd).toBe(0);
    expect(r.changeUsd).toBeGreaterThan(0); // the swaps' profit less the two fees
    expect(r.swapNetUsd - r.feesUsd).toBeCloseTo(r.changeUsd, 10);
  });

  it("is not shown unless every transaction of the position was read from the chain: a partial sum would mislead", () => {
    expect(walletResult([{ walletChange: buy }, { walletChange: null }])).toBeNull();
    expect(walletResult([{ walletChange: buy }, {}])).toBeNull();
    expect(walletResult([])).toBeNull();
  });
});
