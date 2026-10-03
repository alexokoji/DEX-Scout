import { describe, expect, it } from "vitest";
import { CHAIN_IDS, CHAINS, normalizeAddress } from "@/core/chains";
import { MockChainAdapter, MockDexAdapter, MockTokenDataProvider } from "@/core/providers/mock/mockMarket";
import { findTokenByAddress, liveTokenIndices, snapshotAt, toMinute, tokenSpec } from "@/core/providers/mock/world";
import { NOW_MIN } from "./helpers";

describe("multi-chain support", () => {
  it("covers Solana and the major EVM chains", () => {
    expect(CHAIN_IDS.slice(0, 6)).toEqual(["solana", "ethereum", "base", "bsc", "arbitrum", "polygon"]);
    expect(CHAIN_IDS.length).toBeGreaterThan(6);
    expect(CHAINS.base.evmChainId).toBe(8453);
    expect(CHAINS.solana.family).toBe("svm");
  });

  it("mock tokens use chain-appropriate addresses and never collide across chains", () => {
    const seen = new Set<string>();
    for (const c of CHAIN_IDS) {
      const idx = liveTokenIndices(NOW_MIN, c);
      expect(idx.length).toBeGreaterThan(20);
      const t = tokenSpec(idx[idx.length - 1], c);
      expect(t.chain).toBe(c);
      if (CHAINS[c].family === "evm") expect(t.address).toMatch(/^0x[0-9a-f]{40}$/);
      else expect(t.address).toMatch(/^[1-9A-HJ-NP-Za-km-z]{44}$/);
      expect(seen.has(t.address)).toBe(false);
      seen.add(t.address);
      expect(snapshotAt(t, NOW_MIN).chain).toBe(c);
    }
  });

  it("looks tokens up by chain and case-insensitively for EVM", () => {
    const t = tokenSpec(liveTokenIndices(NOW_MIN, "base")[5], "base");
    expect(findTokenByAddress(t.address.toUpperCase().replace("0X", "0x"), NOW_MIN, "base")?.address).toBe(t.address);
    expect(findTokenByAddress(t.address, NOW_MIN, "ethereum")).toBeNull();
    expect(findTokenByAddress(t.address, NOW_MIN)?.chain).toBe("base");
    expect(normalizeAddress("bsc", "0xABCDEF")).toBe("0xabcdef");
    expect(normalizeAddress("solana", "AbC")).toBe("AbC");
  });

  it("quotes use each chain's native symbol and fee level", async () => {
    const data = new MockTokenDataProvider();
    const dex = new MockDexAdapter();
    const eth = (await data.discover("ethereum")).sort((a, b) => b.liquidityUsd - a.liquidityUsd)[0];
    const sol = (await data.discover("solana")).sort((a, b) => b.liquidityUsd - a.liquidityUsd)[0];
    const qe = await dex.getQuote({ chain: "ethereum", side: "BUY", tokenAddress: eth.address, amountUsd: 10, slippageBps: 100 });
    const qs = await dex.getQuote({ chain: "solana", side: "BUY", tokenAddress: sol.address, amountUsd: 10, slippageBps: 100 });
    expect(qe.route[1]).toContain("ETH");
    expect(qs.route[1]).toContain("SOL");
    expect(qe.networkFeeUsd).toBeGreaterThan(qs.networkFeeUsd * 10); // mainnet gas dwarfs Solana fees
  });

  it("mock chain adapters validate the right address format", () => {
    expect(new MockChainAdapter("base").isValidAddress("0x71C7656EC7ab88b098defB751B7401B5f6d8976F")).toBe(true);
    expect(new MockChainAdapter("base").isValidAddress("So11111111111111111111111111111111111111112")).toBe(false);
    expect(new MockChainAdapter("solana").isValidAddress("So11111111111111111111111111111111111111112")).toBe(true);
    expect(new MockChainAdapter("polygon").explorerTxUrl("0xabc")).toContain("polygonscan");
    void toMinute;
  });
});
