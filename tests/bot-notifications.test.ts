/**
 * "I should be receiving notifications as the bot is trading." When the bot trades with its own wallet nothing asks for a signature, so
 * nothing would speak up unless it is made to: the user is told when a trade goes out, when it confirms, and when the bot can't trade
 * at all because its wallet is empty. And a sell the user never signs is re-queued every few minutes: that must not ping every time.
 */
import { describe, expect, it } from "vitest";
import { botNeedsFunds, botTradeSent, CATEGORY_OF, tradeExpired } from "@/services/notificationMessages";

describe("what the user is told while the bot trades", () => {
  it("a trade going out is announced at once, with what and why, and counts as a result the user can mute", () => {
    const buy = botTradeSent({ side: "BUY", symbol: "BONK", chainName: "Solana", usd: 5, tradeId: "t1" });
    expect(buy).toMatchObject({ type: "BOT_ACTIVITY", title: "Bot is buying BONK", dedupeKey: "botsent:t1" });
    expect(buy.body).toMatch(/\$5\.00 of BONK on Solana/);
    const sell = botTradeSent({ side: "SELL", symbol: "BONK", chainName: "Solana", usd: 5.4, reason: "Target 1 reached", tradeId: "t2" });
    expect(sell.title).toBe("Bot is selling BONK");
    expect(sell.body).toMatch(/Target 1 reached/);
    expect(CATEGORY_OF.BOT_ACTIVITY).toBe("results");
  });

  it("an empty bot wallet is said out loud, naming the chain, the coin and the address, and not repeated every minute", () => {
    const m = botNeedsFunds("Base", "ETH", "0x860d4900000000000000000000000000000Fa53");
    expect(m.title).toBe("Bot wallet needs ETH on Base");
    expect(m.body).toMatch(/0x860d…Fa53/);
    expect(m.url).toBe("/settings/autonomous");
    expect(m.dedupeKey).toBe("botfunds:Base");
    expect(m.remindAfterMin).toBeGreaterThanOrEqual(60);
  });

  it("a sell that expires unsigned is one notification per token, not one per expired attempt", () => {
    const first = tradeExpired("TARGET_EXIT", "SELL", "CYBERLEEK", "trade-1");
    const later = tradeExpired("TARGET_EXIT", "SELL", "CYBERLEEK", "trade-2");
    expect(first.dedupeKey).toBe(later.dedupeKey);
    expect(first.remindAfterMin).toBeGreaterThanOrEqual(60);
    expect(tradeExpired("TARGET_EXIT", "SELL", "OTHER", "trade-3").dedupeKey).not.toBe(first.dedupeKey);
    expect(tradeExpired("EMERGENCY_EXIT", "SELL", "CYBERLEEK", "trade-4").dedupeKey).not.toBe(first.dedupeKey); // a different kind of sell is a different problem
  });
});
