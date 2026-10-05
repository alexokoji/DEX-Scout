import { NextResponse } from "next/server";
import { ZodError, type ZodType } from "zod";
import { currentUser } from "./auth";
import { logEvent, safeMessage } from "./events";
import { rateLimitAsync } from "./rateLimit";
import { TradeError } from "@/services/trading";

export class ApiError extends Error {
  constructor(message: string, public status = 400, public details?: unknown) {
    super(message);
  }
}

type Handler<C> = (ctx: { req: Request; user: NonNullable<Awaited<ReturnType<typeof currentUser>>>; params: C }) => Promise<unknown>;

/**
 * Wraps a route handler with authentication, optional rate limiting and uniform error mapping.
 * Internal errors are logged and returned as a generic message — stack traces and provider details never leak.
 */
export function protectedRoute<C = Record<string, string>>(
  handler: Handler<C>,
  opts: { limit?: { max: number; windowMs: number; key: string } } = {},
) {
  return async (req: Request, routeCtx: { params: Promise<C> }) => {
    try {
      const user = await currentUser();
      if (!user) throw new ApiError("Unauthorized", 401);
      if (opts.limit) {
        const rl = await rateLimitAsync(`${opts.limit.key}:${user.id}`, opts.limit.max, opts.limit.windowMs);
        if (!rl.ok) throw new ApiError("Too many requests", 429, { retryAfterSec: rl.retryAfterSec });
      }
      const params = routeCtx?.params ? await routeCtx.params : ({} as C);
      const data = await handler({ req, user, params });
      return NextResponse.json(data ?? { ok: true });
    } catch (err) {
      return errorResponse(err);
    }
  };
}

export function errorResponse(err: unknown) {
  if (err instanceof ApiError) return NextResponse.json({ error: err.message, details: err.details }, { status: err.status });
  if (err instanceof TradeError) return NextResponse.json({ error: err.message, violations: err.violations, hint: err.hint }, { status: err.status });
  if (err instanceof ZodError) {
    return NextResponse.json({ error: "Invalid input", issues: err.issues.map((i) => ({ path: i.path.join("."), message: i.message })) }, { status: 400 });
  }
  console.error("[api] unhandled error:", err);
  void logEvent({ type: "WORKER_ERROR", source: "api", level: "ERROR", message: safeMessage(err) });
  return NextResponse.json({ error: "Internal error" }, { status: 500 });
}

export async function parseBody<T>(req: Request, schema: ZodType<T>): Promise<T> {
  let json: unknown;
  try {
    json = await req.json();
  } catch {
    throw new ApiError("Body must be valid JSON", 400);
  }
  return schema.parse(json);
}

export function serialize<T>(v: T): T {
  // BigInt-safe JSON round trip for Prisma rows
  return JSON.parse(JSON.stringify(v, (_k, val) => (typeof val === "bigint" ? Number(val) : val)));
}
