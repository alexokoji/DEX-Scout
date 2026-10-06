/**
 * "Solana keeps saying connect wallet even though MetaMask is multichain". The unified dialog called select() and then
 * connected the adapter directly; the wallet-adapter provider only follows an adapter once it is bound (after a re-render),
 * so the wallet connected but the app's Solana state never changed. These tests model that library behaviour faithfully.
 */
import { describe, expect, it, vi } from "vitest";
import { connectSolanaWallet, pickSolanaWallet, type SolLike, waitForSolanaWallet } from "@/lib/solanaConnect";

describe("choosing the Solana wallet to connect for an action", () => {
  it("prefers the wallet already connected for EVM (MetaMask offers both), then the last one used, then the only one", () => {
    expect(pickSolanaWallet({ evmName: "MetaMask", selected: "Phantom", installed: ["Phantom", "MetaMask"] })).toBe("MetaMask");
    expect(pickSolanaWallet({ evmName: "Coinbase Wallet", selected: null, installed: ["Coinbase Wallet"] })).toBe("Coinbase Wallet");
    expect(pickSolanaWallet({ evmName: "Phantom", selected: null, installed: ["Phantom Wallet"] })).toBe("Phantom Wallet"); // same wallet, named slightly differently
    expect(pickSolanaWallet({ evmName: "Rabby", selected: "Phantom", installed: ["Phantom", "Backpack"] })).toBe("Phantom"); // Rabby has no Solana: use the last one
    expect(pickSolanaWallet({ evmName: "Rabby", selected: null, installed: ["Backpack"] })).toBe("Backpack"); // the only one there is
  });
  it("won't guess between several, and says none when none is offered", () => {
    expect(pickSolanaWallet({ evmName: "Rabby", selected: null, installed: ["Phantom", "Backpack"] })).toBeNull();
    expect(pickSolanaWallet({ evmName: "MetaMask", selected: null, installed: [] })).toBeNull();
    expect(pickSolanaWallet({ evmName: null, selected: "Gone", installed: [] })).toBeNull();
  });
  it("waits for a wallet that registers a moment after the page loads, and gives up after the timeout", async () => {
    const installed: string[] = [];
    setTimeout(() => installed.push("MetaMask"), 60);
    await expect(waitForSolanaWallet(() => pickSolanaWallet({ evmName: "MetaMask", selected: null, installed }), { timeoutMs: 1000, pollMs: 10 })).resolves.toBe("MetaMask");
    await expect(waitForSolanaWallet(() => null, { timeoutMs: 60, pollMs: 10 })).resolves.toBeNull();
  });
});

/**
 * A wallet-adapter whose select() takes effect only after a delay (a React re-render), and whose connection is only
 * REFLECTED in `connected` when it happens through the provider's connect() with the wallet bound (as in the real
 * library, where the provider listens to the adapter's events only for the selected adapter).
 */
function fakeProvider(opts: { names: string[]; bindDelayMs: number; neverBinds?: boolean; connectFails?: boolean }) {
  const s = {
    wallet: null as { adapter: { name: string } } | null,
    wallets: opts.names.map((n) => ({ adapter: { name: n } })),
    connected: false,
    selected: [] as string[],
    connects: 0,
    adapterConnectedDirectly: 0,
    select(name: string) {
      s.selected.push(name);
      if (!opts.neverBinds) setTimeout(() => (s.wallet = s.wallets.find((w) => w.adapter.name === name) ?? null), opts.bindDelayMs);
    },
    async connect() {
      s.connects++;
      if (opts.connectFails) throw new Error("User rejected the request");
      if (!s.wallet) throw new Error("WalletNotSelectedError");
      s.connected = true; // reflected because the wallet is bound
    },
  };
  return s as typeof s & SolLike;
}

describe("connectSolanaWallet", () => {
  it("waits for the selected wallet to be bound before connecting, so the app's Solana state actually becomes connected", async () => {
    const p = fakeProvider({ names: ["MetaMask", "Phantom"], bindDelayMs: 120 });
    await connectSolanaWallet(() => p, "MetaMask", { pollMs: 10 });
    expect(p.selected).toEqual(["MetaMask"]);
    expect(p.connects).toBe(1);
    expect(p.connected).toBe(true); // before the fix this stayed false: connect ran before the wallet was bound
    expect(p.wallet?.adapter.name).toBe("MetaMask");
  });

  it("the old order (connect immediately after select) really would have failed against this provider", async () => {
    const p = fakeProvider({ names: ["MetaMask"], bindDelayMs: 120 });
    p.select("MetaMask");
    await expect(p.connect()).rejects.toThrow(/WalletNotSelectedError/); // not bound yet: nothing for the app to track
    expect(p.connected).toBe(false);
  });

  it("does not re-select a wallet that is already bound, and does nothing if it is already connected", async () => {
    const p = fakeProvider({ names: ["Phantom"], bindDelayMs: 0 });
    p.wallet = p.wallets[0];
    await connectSolanaWallet(() => p, "Phantom");
    expect(p.selected).toEqual([]);
    expect(p.connects).toBe(1);
    await connectSolanaWallet(() => p, "Phantom");
    expect(p.connects).toBe(1); // already connected
  });

  it("switching to a different Solana wallet re-selects it first", async () => {
    const p = fakeProvider({ names: ["Phantom", "MetaMask"], bindDelayMs: 30 });
    p.wallet = p.wallets[0];
    p.connected = true;
    await connectSolanaWallet(() => p, "MetaMask", { pollMs: 10 });
    expect(p.selected).toEqual(["MetaMask"]);
    expect(p.wallet?.adapter.name).toBe("MetaMask");
  });

  it("reports a wallet that isn't installed, one that never responds, and a user who declines — each with its own message", async () => {
    await expect(connectSolanaWallet(() => fakeProvider({ names: ["Phantom"], bindDelayMs: 0 }), "Backpack")).rejects.toThrow(/not available/);
    await expect(connectSolanaWallet(() => fakeProvider({ names: ["MetaMask"], bindDelayMs: 0, neverBinds: true }), "MetaMask", { timeoutMs: 80, pollMs: 10 })).rejects.toThrow(/did not respond/);
    const declined = fakeProvider({ names: ["MetaMask"], bindDelayMs: 0, connectFails: true });
    await expect(connectSolanaWallet(() => declined, "MetaMask", { pollMs: 5 })).rejects.toThrow(/rejected/);
  });

  it("always reads the CURRENT adapter state (it changes between renders), not a snapshot taken at the start", async () => {
    const first = fakeProvider({ names: ["MetaMask"], bindDelayMs: 0 });
    const next = fakeProvider({ names: ["MetaMask"], bindDelayMs: 0 });
    next.wallet = next.wallets[0];
    const get = vi.fn<() => SolLike>().mockReturnValueOnce(first).mockReturnValue(next); // a re-render swaps the object
    await connectSolanaWallet(get, "MetaMask", { pollMs: 5 });
    expect(next.connected).toBe(true);
  });
});
