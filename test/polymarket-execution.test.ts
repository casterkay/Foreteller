import { describe, expect, it, vi } from "vitest";

import { PolymarketVenueTrader } from "../src/execution/polymarket.js";

describe("PolymarketVenueTrader", () => {
  it("maps a rejected FAK order without retrying it", async () => {
    const placeMarketOrder = vi.fn().mockResolvedValue({
      ok: false,
      code: "fak_not_filled",
      message: "No liquidity within limit",
    });
    const client = {
      placeMarketOrder,
    };
    const trader = new PolymarketVenueTrader(client as never);

    const result = await trader.submitFakMarketBuy(
      {
        clientOrderId: "intent-1",
        tokenId: "yes-token",
        notional: 5,
        maxPrice: 0.5,
        side: "BUY",
        timeInForce: "FAK",
      },
      new AbortController().signal,
    );

    expect(result.status).toBe("rejected");
    expect(placeMarketOrder).toHaveBeenCalledOnce();
  });

  it("keeps a local-only ambiguous order unresolved", async () => {
    const trader = new PolymarketVenueTrader({} as never);

    await expect(
      trader.reconcileOrder(
        { clientOrderId: "intent-without-venue-id" },
        new AbortController().signal,
      ),
    ).resolves.toMatchObject({ status: "unknown" });
  });
});
