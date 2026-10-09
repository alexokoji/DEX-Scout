import { openSecret } from "@/services/botWallet";
import type { BotWalletDoc } from "@/lib/models";

/** Opens a stored bot wallet's secret for a test to check against (the app itself never hands this to a client). */
export const openSecretFor = (doc: BotWalletDoc) => openSecret(doc);
