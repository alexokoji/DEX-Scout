/**
 * "After I finish signing to sell, I still get a Contract Call that says I have insufficient balance." A position's token amount is a
 * float built from the chain's integer balance; turned back into integer units for the swap it could come out a few hundred units
 * ABOVE what the wallet holds, and the token contract refuses to move more than the balance. The numbers below are real wallet
 * balances and the position amounts recorded for them (6 of the 10 open EVM positions were over by 0.8 to 4,600,000,000 units).
 */
import { describe, expect, it } from "vitest";
import { sellRaw } from "@/core/trading/sellAmount";

const real = [
  { name: "XDP", amount: 27.000319473573462, decimals: 18, balance: BigInt("27000319473573461185") }, // the float is above the balance
  { name: "BREW", amount: 84.72077701173909, decimals: 18, balance: BigInt("84720777011739078631") },
  { name: "BOB", amount: 133799735.66923782, decimals: 18, balance: BigInt("133799735669237815380952257") },
  { name: "ZC", amount: 4.064168871173649, decimals: 18, balance: BigInt("4064168871173649583") }, // the float is below the balance
];

describe("a full sale never asks for more than the wallet holds", () => {
  it.each(real)("$name: selling the whole position sells exactly the balance", ({ amount, decimals, balance }) => {
    expect(sellRaw(amount, decimals, balance)).toBe(balance);
  });

  it("a partial sale is the amount asked for, and is never above the balance", () => {
    const { amount, decimals, balance } = real[0];
    const quarter = sellRaw(amount * 0.25, decimals, balance);
    expect(quarter < balance).toBe(true);
    expect(Number(quarter) / Number(balance)).toBeCloseTo(0.25, 10);
  });

  it("asking for more than is held (a stale amount) sells what is held; with no balance to check against, the amount asked for", () => {
    expect(sellRaw(10, 6, BigInt(4_000_000))).toBe(BigInt(4_000_000));
    expect(sellRaw(10, 6, null)).toBe(BigInt(10_000_000));
    expect(sellRaw(10, 6, BigInt(0))).toBe(BigInt(0)); // nothing held: the caller says so rather than asking the wallet to sell it
  });
});
