/** The slice of @solana/wallet-adapter-react's useWallet() that connecting needs. */
export interface SolLike {
  wallet: { adapter: { name: string } } | null;
  wallets: { adapter: { name: string } }[];
  connected: boolean;
  select(name: string): void;
  connect(): Promise<void>;
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
