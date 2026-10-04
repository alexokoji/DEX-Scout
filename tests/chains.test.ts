import { afterEach, describe, expect, it, vi } from "vitest";
import { CHAIN_IDS, CHAINS, hasFreeSwapRoute, ORIGINAL_CHAIN_IDS, rpcCandidates } from "@/core/chains";
import { MultiEvmDexAdapter } from "@/core/providers/evm/freeAggregators";
import { pickRotation } from "@/core/scanner/rotation";
import { collections, newId } from "@/lib/db";

/** Chains with discovery but no free aggregator route (verified live while adding them). */
const NEEDS_KEY = ["ink", "mantle", "scroll", "blast", "world", "abstract", "monad"] as const;

describe("chain registry", () => {
  it("includes the requested chains and every ChainId has a complete entry", () => {
    for (const c of ["robinhood", "ink"] as const) expect(CHAIN_IDS).toContain(c);
    expect(new Set(CHAIN_IDS).size).toBe(CHAIN_IDS.length);
    expect(Object.keys(CHAINS).sort()).toEqual([...CHAIN_IDS].sort());
    const seenIds = new Set<number>();
    for (const c of CHAIN_IDS) {
      const m = CHAINS[c];
      expect(m.dexScreenerId && m.geckoId && m.explorer.startsWith("https://")).toBeTruthy();
      expect(rpcCandidates(c).length).toBeGreaterThanOrEqual(1);
      if (m.family === "evm") {
        expect(m.wrappedNative).toMatch(/^0x[0-9a-fA-F]{40}$/);
        expect(m.evmChainId).toBeGreaterThan(0);
        expect(seenIds.has(m.evmChainId!)).toBe(false); // two chains sharing an id would route swaps to the wrong network
        seenIds.add(m.evmChainId!);
        expect(m.rpcEnv).toBe(`${c.toUpperCase()}_RPC_URL`);
      }
      expect(m.nativeUsdFrom === undefined || CHAINS[m.nativeUsdFrom].nativeSymbol === m.nativeSymbol).toBe(true);
    }
    expect(CHAINS.robinhood.evmChainId).toBe(4663);
    expect(CHAINS.ink.evmChainId).toBe(57073);
  });

  it("the original RPC env var names are unchanged (existing deployments keep working)", () => {
    expect(CHAINS.ethereum.rpcEnv).toBe("ETHEREUM_RPC_URL");
    expect(CHAINS.bsc.rpcEnv).toBe("BSC_RPC_URL");
    expect(CHAINS.polygon.rpcEnv).toBe("POLYGON_RPC_URL");
  });

  it("free-route chains are exactly the ones with a Kyber slug or ParaSwap support", () => {
    for (const c of CHAIN_IDS) {
      const needsKey = (NEEDS_KEY as readonly string[]).includes(c);
      expect(hasFreeSwapRoute(c)).toBe(!needsKey);
    }
  });
});

describe("swap routing per chain", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("only asks the aggregators that actually serve a chain", () => {
    const names = (c: (typeof CHAIN_IDS)[number]) => (new MultiEvmDexAdapter() as unknown as { aggregatorsFor(c: string): { name: string }[] }).aggregatorsFor(c).map((a) => a.name);
    expect(names("ethereum")).toEqual(["paraswap", "kyberswap"]);
    expect(names("linea")).toEqual(["kyberswap"]);
    expect(names("hyperevm")).toEqual(["kyberswap"]);
    expect(names("robinhood")).toEqual(["paraswap", "kyberswap"]);
    expect(names("ink")).toEqual([]);
  });

  it("a chain with no free route fails with an actionable message instead of a pile of 404s, and without any network call", async () => {
    vi.stubEnv("ZEROX_API_KEY", "");
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    await expect(new MultiEvmDexAdapter().getQuote({ chain: "ink", side: "BUY", tokenAddress: "0x" + "1".repeat(40), amountUsd: 10, slippageBps: 100 })).rejects.toThrow(/Ink need a 0x API key.*still work/);
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });
});

describe("rotating scans", () => {
  const chains = [...CHAIN_IDS];

  it("visits every chain within ceil(n/k) ticks, with no repeats inside a lap", () => {
    const k = 6;
    let cursor = 0;
    const seen = new Set<string>();
    for (let t = 0; t < Math.ceil(chains.length / k); t++) {
      const { picked, next } = pickRotation(chains, cursor, k);
      expect(picked).toHaveLength(k);
      expect(new Set(picked).size).toBe(k);
      picked.forEach((c) => seen.add(c));
      cursor = next;
    }
    expect(seen.size).toBe(chains.length);
  });

  it("cost per tick is bounded by k no matter how many chains exist, and wraps cleanly", () => {
    expect(pickRotation(chains, 0, 6).picked).toHaveLength(6);
    expect(pickRotation([...chains, ...chains.map((c) => `${c}2`)], 5, 6).picked).toHaveLength(6);
    const { picked, next } = pickRotation(chains, chains.length - 2, 6);
    expect(picked.slice(0, 2)).toEqual(chains.slice(-2));
    expect(picked.slice(2)).toEqual(chains.slice(0, 4));
    expect(next).toBe(4);
  });

  it("scans everything when the list fits in one tick, or when rotation is disabled, and tolerates a bad cursor", () => {
    expect(pickRotation(["a", "b"], 1, 6)).toEqual({ picked: ["a", "b"], next: 0 });
    expect(pickRotation(chains, 3, 0).picked).toHaveLength(chains.length);
    expect(pickRotation(chains, -7, 6).picked).toHaveLength(6);
    expect(pickRotation(chains, 1e9 + 0.5, 6).picked).toHaveLength(6);
    expect(pickRotation([], 3, 6)).toEqual({ picked: [], next: 0 });
  });
});

let up = false;
try {
  await (await collections.workerStates()).findOne({});
  up = true;
} catch {
  up = false;
}

(up ? describe : describe.skip)("rotation cursor and settings migration (database)", () => {
  it("persists the cursor so successive ticks cover all enabled chains", async () => {
    const { chainsForThisTick } = await import("@/services/scanner");
    const states = await collections.workerStates();
    const saved = await states.findOne({ _id: "scan-cursor" });
    await states.deleteOne({ _id: "scan-cursor" });
    try {
      const seen = new Set<string>();
      for (let i = 0; i < 4; i++) {
        const r = await chainsForThisTick([...CHAIN_IDS], 6);
        expect(r.chains.length).toBeLessThanOrEqual(6);
        expect(r.of).toBe(CHAIN_IDS.length);
        r.chains.forEach((c) => seen.add(c));
      }
      expect(seen.size).toBe(CHAIN_IDS.length);
      // a user who only enabled a few chains is scanned fully every tick, in a stable order
      expect((await chainsForThisTick(["polygon", "solana"], 6)).chains).toEqual(["solana", "polygon"]);
    } finally {
      await states.deleteOne({ _id: "scan-cursor" });
      if (saved) await states.insertOne(saved);
    }
  });

  it("v4 drops the typed-in trading capital and lifts the old $100 deployed cap, keeping a cap the user chose", async () => {
    const { getSettings, defaultSettingsDoc } = await import("@/services/settings");
    const col = await collections.tradingSettings();
    const stale = newId();
    const custom = newId();
    const mk = (userId: string, maxDeployed: number) => {
      const d = defaultSettingsDoc(userId) as ReturnType<typeof defaultSettingsDoc> & { capitalUsd?: number };
      d.settingsVersion = 3;
      d.capitalUsd = 100;
      d.maxDeployedUsd = maxDeployed;
      d.filters = { ...d.filters, chains: ["solana", "base"] }; // a deliberate selection must survive too
      return d;
    };
    try {
      await col.insertMany([mk(stale, 100), mk(custom, 500)] as never);
      const a = await getSettings(stale);
      expect(a.maxDeployedUsd).toBeNull();
      expect("capitalUsd" in a).toBe(false);
      expect((await col.findOne({ userId: stale }) as unknown as { capitalUsd?: number }).capitalUsd).toBeUndefined();
      expect((await getSettings(custom)).maxDeployedUsd).toBe(500);
      expect((await getSettings(stale)).filters.chains).toEqual(["solana", "base"]);
    } finally {
      await col.deleteMany({ userId: { $in: [stale, custom] } });
    }
  });

  it("upgrades accounts still on the original six chains to all chains, but leaves a deliberate selection alone", async () => {
    const { getSettings, defaultSettingsDoc, isOriginalChainSet } = await import("@/services/settings");
    expect(isOriginalChainSet([...ORIGINAL_CHAIN_IDS].reverse())).toBe(true);
    expect(isOriginalChainSet(["solana", "base"])).toBe(false);
    expect(isOriginalChainSet([...ORIGINAL_CHAIN_IDS, "ink"])).toBe(false);

    const col = await collections.tradingSettings();
    const stale = newId();
    const custom = newId();
    const mk = (userId: string, chainsSel: string[]) => {
      const d = defaultSettingsDoc(userId);
      d.settingsVersion = 2;
      d.filters = { ...d.filters, chains: chainsSel as typeof d.filters.chains };
      return d;
    };
    try {
      await col.insertMany([mk(stale, [...ORIGINAL_CHAIN_IDS]), mk(custom, ["solana", "base"])]);
      expect((await getSettings(stale)).filters.chains).toEqual([...CHAIN_IDS]);
      expect((await getSettings(custom)).filters.chains).toEqual(["solana", "base"]);

      // once migrated, narrowing back to the original six is a choice and must stick
      await col.updateOne({ userId: stale }, { $set: { "filters.chains": [...ORIGINAL_CHAIN_IDS] } });
      expect((await getSettings(stale)).filters.chains).toEqual([...ORIGINAL_CHAIN_IDS]);
    } finally {
      await col.deleteMany({ userId: { $in: [stale, custom] } });
    }
  });
});
