/** The slice of @solana/wallet-adapter-react's useWallet() that connecting needs. */
export interface SolLike {
  wallet: { adapter: { name: string } } | null;
  wallets: { adapter: { name: string } }[];
  connected: boolean;
  select(name: string): void;
  connect(): Promise<void>;
}

const sameWallet = (a: string, b: string) => {
  const n = (x: string) => x.toLowerCase().replace(/\s*wallet\s*$/, "").trim();
  return n(a) === n(b);
};

/**
 * Which Solana wallet to connect for an action that needs one, without asking the user to pick: the wallet that is already
 * connected for EVM if it also offers Solana (MetaMask, Phantom, Coinbase...), else the one selected last time, else the only
 * one there is. null = none of those (nothing installed, or several and no way to tell which is meant).
 */
export function pickSolanaWallet(s: { evmName: string | null; selected: string | null; installed: string[] }): string | null {
  if (s.evmName) {
    const same = s.installed.find((i) => sameWallet(i, s.evmName!));
    if (same) return same;
  }
  if (s.selected && s.installed.includes(s.selected)) return s.selected;
  return s.installed.length === 1 ? s.installed[0] : null;
}

/**
 * Wallets register themselves with the page a moment after it loads (Wallet Standard is event-based, and a page that has just
 * opened, or was restored from the background on a phone, can be asked to sign before MetaMask has said it is there). Give
 * them a few seconds before concluding there is no Solana wallet.
 */
export async function waitForSolanaWallet(find: () => string | null, opts: { timeoutMs?: number; pollMs?: number } = {}): Promise<string | null> {
  const timeoutMs = opts.timeoutMs ?? 3000;
  const pollMs = opts.pollMs ?? 100;
  const t0 = Date.now();
  for (;;) {
    const hit = find();
    if (hit || Date.now() - t0 >= timeoutMs) return hit;
    await new Promise((r) => setTimeout(r, pollMs));
  }
}

/**
 * Connect a named Solana wallet so that the app's own Solana state follows.
 *
 * select() only takes effect after a re-render, and the provider listens to an adapter's events only once it is the
 * selected one. Calling adapter.connect() straight after select() connected the wallet but the app never noticed: the
 * dialog said "MetaMask connected (EVM + Solana)" while Solana still read "not connected", and every Solana action asked
 * to connect again. So wait until the provider has actually bound the wallet, then connect through the provider.
 *
 * `get` returns the CURRENT wallet-adapter state (it changes between renders).
 */
export async function connectSolanaWallet(get: () => SolLike, name: string, opts: { timeoutMs?: number; pollMs?: number } = {}): Promise<void> {
  const timeoutMs = opts.timeoutMs ?? 4000;
  const pollMs = opts.pollMs ?? 40;
  if (get().wallet?.adapter.name !== name) {
    if (!get().wallets.some((w) => w.adapter.name === name)) throw new Error("Solana wallet not available");
    get().select(name);
    const t0 = Date.now();
    while (get().wallet?.adapter.name !== name) {
      if (Date.now() - t0 > timeoutMs) throw new Error("The Solana wallet did not respond");
      await new Promise((r) => setTimeout(r, pollMs));
    }
  }
  if (!get().connected) await get().connect();
}
