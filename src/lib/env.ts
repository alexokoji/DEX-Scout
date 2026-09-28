import { z } from "zod";

const bool = z
  .string()
  .optional()
  .transform((v) => v === "true" || v === "1");

const schema = z.object({
  MONGODB_URI: z.string().min(1).default("mongodb://127.0.0.1:27117/dexscout?replicaSet=rs0"),
  /** Overrides the database name from MONGODB_URI's path when set (handy for Atlas connection strings). */
  MONGODB_DB: z.string().optional(),
  CRON_SECRET: z.string().optional(),
  AUTH_SECRET: z.string().min(16).default("dev-only-insecure-secret-change-me-please"),
  MOCK_PROVIDER: bool,
  LIVE_TRADING_ENABLED: bool,
  SOLANA_RPC_URL: z.string().default("https://api.mainnet-beta.solana.com"),
  SOLANA_WS_URL: z.string().optional(),
  DEX_PROVIDER_URL: z.string().default("https://lite-api.jup.ag/swap/v1"),
  DEX_PROVIDER_API_KEY: z.string().optional(),
  MARKET_DATA_API_KEY: z.string().optional(),
  BIRDEYE_API_KEY: z.string().optional(),
  UPSTASH_REDIS_REST_URL: z.string().optional(),
  UPSTASH_REDIS_REST_TOKEN: z.string().optional(),
  MARKET_DATA_URL: z.string().default("https://api.dexscreener.com"),
  AI_API_KEY: z.string().optional(),
  AI_MODEL: z.string().default("claude-sonnet-5"),
  SCANNER_INTERVAL_SECONDS: z.coerce.number().default(30),
  MONITOR_INTERVAL_SECONDS: z.coerce.number().default(15),
  NEXT_PUBLIC_APP_URL: z.string().default("http://localhost:3000"),
});

export type Env = z.infer<typeof schema>;

let cached: Env | null = null;

/** Server-only. Never import this from a client component. */
export function env(): Env {
  if (cached) return cached;
  const parsed = schema.safeParse(process.env);
  if (!parsed.success) {
    throw new Error(`Invalid environment: ${parsed.error.issues.map((i) => i.path.join(".")).join(", ")}`);
  }
  if (process.env.NODE_ENV === "production" && parsed.data.AUTH_SECRET.startsWith("dev-only")) {
    throw new Error("AUTH_SECRET must be set in production");
  }
  cached = parsed.data;
  return cached;
}

/** Live trading requires an explicit opt-in AND real (non-mock) providers. */
export function liveTradingAllowed(): boolean {
  const e = env();
  return e.LIVE_TRADING_ENABLED && !e.MOCK_PROVIDER;
}
