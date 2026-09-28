import { protectedRoute } from "@/lib/api";
import { walletBalances } from "@/services/queries";

/** Balances are fetched server-side so RPC keys never reach the browser. Only the user's linked wallets are queried. */
export const GET = protectedRoute(async ({ user }) => walletBalances(user.id));
