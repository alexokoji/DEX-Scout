import { CHAIN_IDS, CHAINS } from "@/core/chains";
import { evmRpc } from "@/core/providers/evm/evmProviders";
import { rpcGoodHost } from "@/core/providers/rpcHealth";
import { solanaTry } from "@/core/providers/solana/solanaProviders";
import { protectedRoute, serialize } from "@/lib/api";
import { env } from "@/lib/env";

interface Check {
  id: string;
  ok: boolean;
  ms: number;
  detail: string;
}

async function timed(id: string, fn: () => Promise<string>): Promise<Check> {
  const t0 = Date.now();
  try {
    const detail = await fn(); // await first: object-literal properties evaluate in order, so measuring inline reported ~0ms
    return { id, ok: true, ms: Date.now() - t0, detail };
  } catch (e) {
    return { id, ok: false, ms: Date.now() - t0, detail: e instanceof Error ? e.message.slice(0, 120) : "failed" };
  }
}

const ping = async (url: string, init?: RequestInit) => {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 9_000);
  try {
    const r = await fetch(url, { ...init, signal: ctl.signal, cache: "no-store" });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return r;
  } finally {
    clearTimeout(timer);
  }
};

const WETH_ETH = "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2";
const USDC_ETH = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
const NATIVE = "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE";

/** Actually exercises each integration so the Integrations page can show what works right now. Read-only. */
export const GET = protectedRoute(
  async () => {
    if (env().MOCK_PROVIDER) return serialize({ mock: true, checks: [] as Check[] });
    const checks = await Promise.all([
      ...CHAIN_IDS.filter((c) => CHAINS[c].family === "evm").map((c) =>
        timed(`rpc:${c}`, async () => {
          await evmRpc<string>(c, "eth_blockNumber", [], 8_000);
          return `answered by ${rpcGoodHost(c) ?? "an endpoint"}`;
        }),
      ),
      timed("rpc:solana", async () => {
        const slot = await solanaTry((c) => c.getSlot(), 8_000);
        return `slot ${slot}`;
      }),
      timed("market-data:dexscreener", async () => {
        await ping(`${env().MARKET_DATA_URL}/token-boosts/latest/v1`);
        return "DexScreener reachable";
      }),
      timed("market-data:geckoterminal", async () => {
        await ping("https://api.geckoterminal.com/api/v2/networks?page=1");
        return "GeckoTerminal reachable";
      }),
      timed("swaps:jupiter", async () => {
        const r = await ping(`${env().DEX_PROVIDER_URL}/quote?inputMint=So11111111111111111111111111111111111111112&outputMint=EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v&amount=10000000&slippageBps=50`, {
          headers: env().DEX_PROVIDER_API_KEY ? { "x-api-key": env().DEX_PROVIDER_API_KEY! } : undefined,
        });
        const j = (await r.json()) as { outAmount?: string };
        if (!j.outAmount) throw new Error("no quote returned");
        return "Solana quote returned";
      }),
      timed("swaps:paraswap", async () => {
        const r = await ping(`https://api.paraswap.io/prices?srcToken=${NATIVE}&destToken=${USDC_ETH}&amount=10000000000000000&srcDecimals=18&destDecimals=6&side=SELL&network=1&version=6.2`);
        const j = (await r.json()) as { priceRoute?: unknown };
        if (!j.priceRoute) throw new Error("no route returned");
        return "ParaSwap quote returned (no key)";
      }),
      timed("swaps:kyberswap", async () => {
        const r = await ping(`https://aggregator-api.kyberswap.com/ethereum/api/v1/routes?tokenIn=${NATIVE}&tokenOut=${WETH_ETH}&amountIn=10000000000000000`, { headers: { "x-client-id": "dexscout" } });
        const j = (await r.json()) as { data?: { routeSummary?: unknown } };
        if (!j.data?.routeSummary) throw new Error("no route returned");
        return "KyberSwap quote returned (no key)";
      }),
    ]);
    return serialize({ mock: false, checks });
  },
  { limit: { max: 10, windowMs: 60_000, key: "integrations-health" } },
);
