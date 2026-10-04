/**
 * "A target sell was queued" notifications: wording, channel safety (fixed hosts only), failure isolation, de-duplication,
 * and the real path — the position monitor reaching a target queues a sell and tells the user.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("next/headers", () => ({ cookies: async () => ({ get: () => undefined, set: () => {}, delete: () => {} }) }));
vi.mock("@/lib/env", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/env")>()), liveTradingAllowed: () => true }));

import { closeDb, collections, newId } from "@/lib/db";
import { notificationPrefsInput, pushToChannels, saveNotificationPrefs } from "@/services/notifications";
import { sellQueuedNotification } from "@/services/trading";

let dbUp = false;
try {
  await (await collections.users()).findOne({});
  dbUp = true;
} catch {
  dbUp = false;
}
afterAll(async () => {
  if (dbUp) await closeDb();
});

describe("wording", () => {
  it("says what, how much and how long, and keeps the push title plain ASCII", () => {
    const t = sellQueuedNotification("TARGET_EXIT", "PEPE", "Base", "Target 2 reached", 0.25, 12.5, "t1", "p1");
    expect(t.title).toBe("Target hit: PEPE sell ready to sign");
    expect(t.body).toContain("Sell 25% (~$12.50) on Base");
    expect(t.body).toContain("10 minutes");
    expect(t.url).toBe("/wallet");
    expect(t.dedupeKey).toBe("sell:p1:TARGET_EXIT");
    expect(sellQueuedNotification("EMERGENCY_EXIT", "X", "Base", "r", 1, 1, "t").title).toMatch(/Emergency exit ready/);
    expect(sellQueuedNotification("TARGET_EXIT", "X", "Base", "r", 7, 1, "t").body).toContain("Sell 100%"); // clamped
  });
});

describe("channel settings are validated so the server only ever calls fixed hosts", () => {
  const ok = { ntfyTopic: "dexscout-k3j9x2m7q", discordWebhook: "https://discord.com/api/webhooks/123456789/abc_DEF-123" };
  it("accepts a proper topic and Discord webhook, and allows both to be empty", () => {
    expect(notificationPrefsInput.safeParse(ok).success).toBe(true);
    expect(notificationPrefsInput.safeParse({ ntfyTopic: null, discordWebhook: null }).success).toBe(true);
  });
  it("rejects guessable topics, path tricks and non-Discord webhook hosts (no SSRF)", () => {
    for (const ntfyTopic of ["short", "has space here", "../evil/path", "a/b/c/d/e/f/g/h"]) expect(notificationPrefsInput.safeParse({ ...ok, ntfyTopic }).success).toBe(false);
    for (const discordWebhook of [
      "http://discord.com/api/webhooks/1/x", "https://evil.com/api/webhooks/1/x", "https://discord.com.evil.com/api/webhooks/1/x",
      "https://discord.com/api/webhooks/1/x?redirect=http://169.254.169.254", "http://169.254.169.254/latest/meta-data", "https://localhost/api/webhooks/1/x",
    ]) expect(notificationPrefsInput.safeParse({ ...ok, discordWebhook }).success).toBe(false);
  });
});

(dbUp ? describe : describe.skip)("delivery", () => {
  const userId = newId();
  afterEach(() => vi.restoreAllMocks());
  afterAll(async () => {
    await Promise.all([(await collections.notifications()).deleteMany({ userId }), (await collections.notificationPrefs()).deleteMany({ _id: userId })]).catch(() => {});
  });

  it("pushes to ntfy and Discord at their fixed URLs, with an ASCII title header and no mention parsing", async () => {
    await saveNotificationPrefs(userId, { ntfyTopic: "dexscout-k3j9x2m7q", discordWebhook: "https://discord.com/api/webhooks/123456789/abc" });
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("ok", { status: 200 }));
    const res = await pushToChannels(userId, { type: "SELL_QUEUED", title: "Target hit: PEPE — sell ready", body: "Sell 25%", url: "/wallet" });
    expect(res).toEqual([{ channel: "ntfy", ok: true }, { channel: "discord", ok: true }]);
    const [ntfyCall, discordCall] = fetchSpy.mock.calls;
    expect(ntfyCall[0]).toBe("https://ntfy.sh/dexscout-k3j9x2m7q");
    const h = (ntfyCall[1] as RequestInit).headers as Record<string, string>;
    expect(h.Title).toBe("Target hit: PEPE  sell ready"); // non-ASCII dropped: header values must be Latin-1
    expect(h.Click).toMatch(/\/wallet$/);
    expect(discordCall[0]).toBe("https://discord.com/api/webhooks/123456789/abc");
    expect(JSON.parse((discordCall[1] as RequestInit).body as string).allowed_mentions).toEqual({ parse: [] });
  });

  it("one failing channel neither throws nor stops the others, and the in-app notification is still recorded", async () => {
    const { notifyUser } = await import("@/services/notifications");
    vi.spyOn(globalThis, "fetch").mockImplementation(async (url) => (String(url).includes("ntfy.sh") ? Promise.reject(new Error("network down")) : new Response("ok", { status: 200 })));
    await expect(notifyUser(userId, { type: "SELL_QUEUED", title: "T", body: "B", url: "/wallet", tradeId: "x" })).resolves.toBeUndefined();
    const rows = await (await collections.notifications()).find({ userId, tradeId: "x" }).toArray();
    expect(rows).toHaveLength(1);
    expect(rows[0].readAt).toBeNull();
  });

  it("does not repeat a notification with the same key inside the reminder window, but does after it", async () => {
    const { notifyUser } = await import("@/services/notifications");
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("ok", { status: 200 }));
    const col = await collections.notifications();
    const n = { type: "SELL_QUEUED" as const, title: "T", body: "B", url: "/wallet", dedupeKey: `k-${userId}` };
    await notifyUser(userId, n);
    await notifyUser(userId, n);
    expect(await col.countDocuments({ userId, dedupeKey: n.dedupeKey })).toBe(1);
    await col.updateMany({ userId, dedupeKey: n.dedupeKey }, { $set: { createdAt: new Date(Date.now() - 2 * 3_600_000) } });
    await notifyUser(userId, n);
    expect(await col.countDocuments({ userId, dedupeKey: n.dedupeKey })).toBe(2);
  });
});

(dbUp ? describe : describe.skip)("position monitor → queued target sell → notification", () => {
  const userId = newId();
  const created = { positionId: "", tradeIds: [] as string[] };
  let tokenId = "";

  beforeAll(async () => {
    const { runScanCycle } = await import("@/services/scanner");
    const tokens = await collections.tokens();
    let t = await tokens.findOne({ chain: "solana", passedFilters: true });
    if (!t) {
      await runScanCycle({ chainsPerTick: 0 });
      t = await tokens.findOne({ chain: "solana", passedFilters: true });
    }
    if (!t) throw new Error("no mock token available");
    tokenId = t._id;
    const now = new Date();
    await (await collections.users()).insertOne({ _id: userId, email: `notif-${Date.now()}@test.local`, passwordHash: "x", name: null, role: "USER", createdAt: now });
    const accountId = newId();
    await (await collections.tradingAccounts()).insertOne({ _id: accountId, userId, environment: "LIVE", realizedPnlUsd: 0, createdAt: now });
    await (await collections.wallets()).insertOne({ _id: newId(), userId, chain: "solana", address: "W".repeat(44), label: null, verifiedAt: now, createdAt: now });
    created.positionId = newId();
    // a MANUAL position entered at half today's price: +100%, past every default target
    await (await collections.positions()).insertOne({
      _id: created.positionId, userId, accountId, tokenId, environment: "LIVE", status: "OPEN", health: "HEALTHY", healthNotes: null, origin: "MANUAL", sourceSignalId: null,
      entryPriceUsd: t.priceUsd / 2, currentPriceUsd: t.priceUsd, initialAmount: 1000, amount: 1000, investedUsd: 500 * t.priceUsd / 1000 * 1000 / 1000, costBasisUsd: (t.priceUsd / 2) * 1000, realizedPnlUsd: 0,
      targetsHit: 0, targetsSnapshot: [{ level: 1, gainPct: 8, sellPct: 25 }, { level: 2, gainPct: 15, sellPct: 100 }], emergencyEnabled: false, emergencyAutoExit: false,
      openedAt: now, updatedAt: now, closedAt: null, lastAnalysisAt: null,
    } as never);
  });

  afterEach(() => vi.restoreAllMocks());
  afterAll(async () => {
    await Promise.all([
      (await collections.users()).deleteOne({ _id: userId }), (await collections.tradingAccounts()).deleteMany({ userId }), (await collections.wallets()).deleteMany({ userId }),
      (await collections.positions()).deleteMany({ userId }), (await collections.trades()).deleteMany({ userId }), (await collections.notifications()).deleteMany({ userId }),
    ]).catch(() => {});
  });

  it("a hand-made position hitting its target queues a sell and raises exactly one notification, even when the sell re-queues", async () => {
    const { providers } = await import("@/core/providers/registry");
    const { monitorPosition } = await import("@/services/positionMonitor");
    vi.spyOn(providers().dex, "buildSwapTransaction").mockResolvedValue({ unsignedTxBase64: "unsigned" });
    vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => (String(url).includes("ntfy.sh") || String(url).includes("discord.com") ? new Response("ok") : fetch.call(globalThis, url as never, init)));

    const positions = await collections.positions();
    const trades = await collections.trades();
    const notifs = await collections.notifications();
    const tokens = await collections.tokens();
    const token = (await tokens.findOne({ _id: tokenId }))!;
    // pin the market price the monitor will see to the token's current price (the position entered at half of it)
    vi.spyOn(providers().data, "getSnapshot").mockResolvedValue({
      chain: token.chain, address: token.address, name: token.name, symbol: token.symbol, decimals: token.decimals, dex: token.dex, poolAddress: token.poolAddress, poolCreatedAt: token.poolCreatedAt,
      pairCount: 1, priceUsd: token.priceUsd, marketCapUsd: token.marketCapUsd, fdvUsd: token.fdvUsd, liquidityUsd: 500_000, liquidity1hAgoUsd: 500_000, volume5m: 1, volume15m: 1, volume30m: 1,
      volume1h: 1, volume24h: 1, buys5m: 1, sells5m: 1, buys15m: 1, sells15m: 1, buys1h: 1, sells1h: 1, change5m: 0, change1h: 0, change24h: 0, holders: 100, holders1hAgo: 100, observedAt: new Date(), dataSource: "MOCK",
    } as never);

    const run = async () => monitorPosition((await positions.findOne({ _id: created.positionId }))!, token);
    await run();
    const sells = await trades.find({ userId, side: "SELL" }).toArray();
    expect(sells).toHaveLength(1);
    expect(sells[0].status).toBe("PREPARED");
    let n = await notifs.find({ userId }).toArray();
    expect(n).toHaveLength(1);
    expect(n[0]).toMatchObject({ type: "SELL_QUEUED", tradeId: sells[0]._id, url: "/wallet", readAt: null });
    expect(n[0].title).toContain(token.symbol);
    expect(n[0].body).toMatch(/Sell \d+%/);

    // the user ignored it: it expires and the monitor queues a fresh one — but must not ping again straight away
    await trades.updateOne({ _id: sells[0]._id }, { $set: { status: "EXPIRED" } });
    await run();
    expect(await trades.countDocuments({ userId, side: "SELL", status: "PREPARED" })).toBe(1);
    n = await notifs.find({ userId }).toArray();
    expect(n).toHaveLength(1);
  });
});
