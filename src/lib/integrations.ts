/**
 * Every external service DEX Scout talks to, in one place: what it powers, whether it needs a key, where to get
 * one, and which environment variable takes it. Used by the Integrations page. Status is derived from the
 * environment on the server and NEVER includes a value — only whether one is set.
 *
 * The design rule: nothing here is required to trade. Each capability has a free, keyless default; a key only
 * upgrades speed or limits. (The two things you must set are your own database and your own secrets.)
 */

export interface Integration {
  id: string;
  name: string;
  /** what this powers in the app */
  powers: string;
  /** "required" must be set by the operator; "optional" has a free working default */
  kind: "required" | "optional";
  /** how it works with no key (null for required items) */
  freeDefault: string | null;
  /** env vars that configure it (any one set counts as "yours"); first is the primary */
  envVars: string[];
  /** where to get a key / account */
  getUrl: string;
  getLabel: string;
  /** what a key actually buys you, or caveats */
  note: string;
}

export const INTEGRATIONS: Integration[] = [
  {
    id: "database", name: "MongoDB database", powers: "Accounts, settings, tokens, signals, positions, trades", kind: "required", freeDefault: null,
    envVars: ["MONGODB_URI"], getUrl: "https://www.mongodb.com/cloud/atlas/register", getLabel: "MongoDB Atlas (free tier)",
    note: "Create a free cluster, allow network access from anywhere (0.0.0.0/0) so Vercel can reach it, and paste the connection string.",
  },
  {
    id: "auth", name: "Session secret", powers: "Signing login sessions", kind: "required", freeDefault: null,
    envVars: ["AUTH_SECRET"], getUrl: "https://generate-secret.vercel.app/32", getLabel: "Generate a random secret",
    note: "Any random string of 16+ characters. Changing it later logs everyone out.",
  },
  {
    id: "cron", name: "Scheduler secret", powers: "Authorising the background-job endpoints your scheduler calls", kind: "required", freeDefault: null,
    envVars: ["CRON_SECRET"], getUrl: "https://cron-job.org", getLabel: "cron-job.org (free scheduler)",
    note: "Any random string of 16+ characters; the same value goes in the Authorization header of each scheduled job.",
  },
  {
    id: "market-data", name: "Market data (DexScreener + GeckoTerminal)", powers: "Finding tokens, prices, volume, charts", kind: "optional",
    freeDefault: "Free public APIs, no key. Blended so one being rate-limited doesn't stop discovery.",
    envVars: ["MARKET_DATA_API_KEY"], getUrl: "https://www.geckoterminal.com/dex-api", getLabel: "GeckoTerminal / CoinGecko API plans",
    note: "A paid plan raises the rate limits that otherwise cap how many tokens can be analysed per minute.",
  },
  {
    id: "evm-rpc", name: "EVM RPC (Ethereum, Base, BNB, Arbitrum, Polygon)", powers: "On-chain safety checks, wallet balances, trade confirmation", kind: "optional",
    freeDefault: "Several free public endpoints per chain with automatic failover; dead or slow ones are skipped.",
    envVars: ["ETHEREUM_RPC_URL", "BASE_RPC_URL", "BSC_RPC_URL", "ARBITRUM_RPC_URL", "POLYGON_RPC_URL"], getUrl: "https://dashboard.alchemy.com", getLabel: "Alchemy / Infura / QuickNode / dRPC (free tiers)",
    note: "Set one URL per chain you care about. Yours is tried first, the free ones stay as backup. Faster and more reliable than shared public nodes.",
  },
  {
    id: "solana-rpc", name: "Solana RPC", powers: "Mint/freeze authority checks, wallet balance, trade confirmation", kind: "optional",
    freeDefault: "Free public endpoints with failover. Authority checks work; top-holder concentration does not (free nodes block it).",
    envVars: ["SOLANA_RPC_URL"], getUrl: "https://dashboard.helius.dev/signup", getLabel: "Helius (free tier)",
    note: "The one place a key adds real capability: a capable RPC unlocks top-holder concentration, a rug-risk signal. Also set NEXT_PUBLIC_SOLANA_RPC_URL for the browser (use a domain-restricted key).",
  },
  {
    id: "solana-swaps", name: "Solana swaps (Jupiter)", powers: "Quotes and swap transactions on Solana", kind: "optional",
    freeDefault: "Jupiter's free Lite API, no key.", envVars: ["DEX_PROVIDER_API_KEY"], getUrl: "https://portal.jup.ag", getLabel: "Jupiter portal",
    note: "A key raises rate limits. Not needed for normal use.",
  },
  {
    id: "evm-swaps", name: "EVM swaps (ParaSwap + KyberSwap, optional 0x)", powers: "Quotes and swap transactions on Ethereum, Base, BNB, Arbitrum, Polygon", kind: "optional",
    freeDefault: "ParaSwap, then KyberSwap, both free with no key. If one has no route or is down, the next is tried.",
    envVars: ["ZEROX_API_KEY"], getUrl: "https://dashboard.0x.org", getLabel: "0x dashboard",
    note: "Not required. If you add a 0x key it is simply tried first.",
  },
  {
    id: "holders", name: "Holder data (Birdeye)", powers: "Holder counts and growth in the score", kind: "optional",
    freeDefault: "Not used; holder count is treated as unknown (neutral) rather than bad.", envVars: ["BIRDEYE_API_KEY"], getUrl: "https://birdeye.so/developers", getLabel: "Birdeye developer portal",
    note: "Adds holder count and growth for every chain.",
  },
  {
    id: "ai", name: "AI analysis (Anthropic)", powers: "The written interpretation on each signal (display only; never gates a trade)", kind: "optional",
    freeDefault: "A built-in rules-based summariser fills the same fields.", envVars: ["AI_API_KEY"], getUrl: "https://console.anthropic.com", getLabel: "Anthropic Console",
    note: "Optional polish; trading decisions never depend on it.",
  },
  {
    id: "ratelimit", name: "Shared rate limiting (Upstash Redis)", powers: "Login/API rate limits that hold across serverless instances", kind: "optional",
    freeDefault: "In-memory limiter (per instance, so weaker on Vercel).", envVars: ["UPSTASH_REDIS_REST_URL", "UPSTASH_REDIS_REST_TOKEN"], getUrl: "https://console.upstash.com", getLabel: "Upstash (free tier)",
    note: "Set both variables. Available as a one-click add-on in the Vercel Marketplace.",
  },
];

export type IntegrationStatus = "yours" | "free" | "missing";

export interface IntegrationView extends Integration {
  status: IntegrationStatus;
  /** which of envVars are set (names only) */
  configured: string[];
}

const isSet = (name: string) => !!process.env[name]?.trim();

/** Server-only. Reports whether each integration is configured; never the values. */
export function integrationViews(): IntegrationView[] {
  return INTEGRATIONS.map((i) => {
    const configured = i.envVars.filter(isSet);
    const status: IntegrationStatus = configured.length ? "yours" : i.kind === "required" ? "missing" : "free";
    return { ...i, status, configured };
  });
}
