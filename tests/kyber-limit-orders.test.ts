/** KyberSwap limit-order client against responses shaped like the real service (captured live while building it). */
import { afterEach, describe, expect, it, vi } from "vitest";
import { kyberCancelSign, kyberContract, kyberFills, kyberFindOrder, kyberSignMessage, submitKyberOrder, type KyberOrder } from "@/core/providers/limitOrders/kyber";

const ok = (data: unknown) => new Response(JSON.stringify({ code: 0, message: "Succeeded", data }), { status: 200 });
const err = (status: number, code: number, message: string, entities: string[] = []) => new Response(JSON.stringify({ code, message, errorEntities: entities }), { status });

const real = (over: Partial<KyberOrder> = {}): KyberOrder => ({
  id: 56257, status: "partially_filled", makerAsset: "0xbc45647ea894030a4e9801ec03479739fa2485f0", takerAsset: "0x4200000000000000000000000000000000000006",
  makingAmount: "2784081234934899949049", takingAmount: "111363249397395998", filledMakingAmount: "2462441885219949998", filledTakingAmount: "98497675408798", expiredAt: 1872754560,
  transactions: [{ txHash: "0xc6ad937d9f5bcdaa90e1ac9ccb45636e9e42fc04991434bc26a64bca3e89cbeb" }, { txHash: "0x" + "ab".repeat(32) }], ...over,
});

afterEach(() => vi.restoreAllMocks());

describe("Kyber limit-order client", () => {
  it("the signing domain's chainId is always a number (a string signed as an invalid signature on Kyber's own cancel endpoint)", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (url) =>
      String(url).includes("cancel-sign")
        ? ok({ types: { CancelOrder: [] }, domain: { chainId: "8453", name: "Kyber Limit Order Protocol", version: "1" }, primaryType: "CancelOrder", message: { chainId: "8453", maker: "0x1", orderIds: [7] } })
        : ok({ types: { Order: [] }, domain: { chainId: "10", name: "Kyber DSLO Protocol", version: "1", verifyingContract: "0xcab2" }, primaryType: "Order", message: { salt: "1" } }),
    );
    expect((await kyberCancelSign("base", "0xabc", [7])).domain.chainId).toBe(8453);
    expect((await kyberSignMessage({ chainId: "10", makerAsset: "0xa", takerAsset: "0xb", maker: "0xc", allowedSenders: [], makingAmount: "1", takingAmount: "1", expiredAt: 1 })).domain.chainId).toBe(10);
  });

  it("asks for the right chain and returns the order contract; an unsupported chain is a clear error", async () => {
    const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(ok({ latest: "0xcab2fa2eeab7065b45cbcf6e3936dde2506b4f6c" }));
    expect((await kyberContract("optimism")).toLowerCase()).toBe("0xcab2fa2eeab7065b45cbcf6e3936dde2506b4f6c"); // returned checksummed
    expect(String(spy.mock.calls[0][0])).toContain("chainId=10");
    spy.mockResolvedValue(err(400, 4001, "Input is not in the accepted values: ChainID", ["ChainID"]));
    await expect(kyberContract("scroll")).rejects.toThrow(/accepted values: ChainID/);
  });

  it("order creation: reads the new id when Kyber returns one, tolerates it not doing so, and surfaces Kyber's message on rejection", async () => {
    const req = { chainId: "10", makerAsset: "0xa", takerAsset: "0xb", maker: "0xc", allowedSenders: [], makingAmount: "1", takingAmount: "1", expiredAt: 1 };
    const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(ok({ id: 123 }));
    expect(await submitKyberOrder(req, "99", "0xsig")).toEqual({ id: 123 });
    expect(JSON.parse(String((spy.mock.calls[0][1] as RequestInit).body))).toMatchObject({ ...req, salt: "99", signature: "0xsig" });
    spy.mockResolvedValue(ok(null));
    expect(await submitKyberOrder(req, "99", "0xsig")).toEqual({ id: null });
    spy.mockResolvedValue(err(400, 4002, "Input is out of range: makingAmount", ["makingAmount"]));
    await expect(submitKyberOrder(req, "99", "0xsig")).rejects.toThrow(/out of range: makingAmount \(makingAmount\)/);
  });

  it("finds an order by id or, when its id was never returned, by all of its fields; looks in active orders then closed ones", async () => {
    const open = real();
    const closed = real({ id: 56242, status: "expired", makingAmount: "100", takingAmount: "200", expiredAt: 5 });
    const spy = vi.spyOn(globalThis, "fetch").mockImplementation(async (url) => ok({ orders: String(url).includes("status=active") ? [open] : [closed], pagination: { hasMore: false } }));
    expect((await kyberFindOrder("base", "0xAbC", { id: 56257 }))?.id).toBe(56257);
    expect((await kyberFindOrder("base", "0xAbC", { id: 56242 }))?.status).toBe("expired"); // found in the closed list
    expect(String(spy.mock.calls[0][0])).toContain("maker=0xabc"); // addresses are lower-cased for the listing
    const byFields = await kyberFindOrder("base", "0xabc", { req: { chainId: "8453", makerAsset: open.makerAsset.toUpperCase(), takerAsset: open.takerAsset, maker: "0xabc", allowedSenders: [], makingAmount: open.makingAmount, takingAmount: open.takingAmount, expiredAt: open.expiredAt } });
    expect(byFields?.id).toBe(56257);
    // one field off (a different target price) is a different order
    expect(await kyberFindOrder("base", "0xabc", { req: { chainId: "8453", makerAsset: open.makerAsset, takerAsset: open.takerAsset, maker: "0xabc", allowedSenders: [], makingAmount: open.makingAmount, takingAmount: "1", expiredAt: open.expiredAt } })).toBeNull();
    expect(await kyberFindOrder("base", "0xabc", { id: 1 })).toBeNull();
  });

  it("fills come from the filled amounts and the latest settlement transaction", () => {
    const f = kyberFills(real());
    expect(f.sellRaw).toBe(BigInt("2462441885219949998"));
    expect(f.buyRaw).toBe(BigInt("98497675408798"));
    expect(f.txHash).toBe("0x" + "ab".repeat(32));
    expect(kyberFills(real({ filledMakingAmount: "0", filledTakingAmount: "0", transactions: [] }))).toEqual({ sellRaw: BigInt(0), buyRaw: BigInt(0), txHash: null });
  });
});
