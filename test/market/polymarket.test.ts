import { describe, expect, it } from "vitest";

import type { Event, MarketInfo, OrderBook } from "@polymarket/client";

import {
  PolymarketMarketData,
  type PolymarketReadClient,
} from "../../src/market/polymarket.js";

const term = {
  marketId: "mention-market",
  label: "Trade",
  acceptedForms: ["trade"],
  excludedForms: [],
  speakerScope: "primary" as const,
  windowStartMs: 0,
  windowEndMs: 1_000,
};

describe("PolymarketMarketData", () => {
  it("selects only explicit TermSpec markets and hashes their reviewed rules", async () => {
    const event = {
      id: "event-1",
      title: "Speech",
      markets: [
        {
          id: "mention-market",
          conditionId: "condition-1",
          question: "Will the speaker say trade?",
          description: "Resolves YES if the speaker says trade.",
          state: { acceptingOrders: true },
          trading: { minimumOrderSize: "5" },
        },
        {
          id: "no-qualifying-event",
          conditionId: "condition-2",
          question: "No Qualifying Event",
          description: "A separate outcome market.",
          state: { acceptingOrders: true },
          trading: { minimumOrderSize: "5" },
        },
      ],
    } as unknown as Event;
    const marketInfo = {
      feeInfo: { rate: 0.1, exponent: 1 },
      negRisk: false,
      tickSize: 0.01,
      tokens: [
        { outcome: "Yes", assetId: "yes-token" },
        { outcome: "No", assetId: "no-token" },
      ],
    } as unknown as MarketInfo;
    const client = fakeClient(event, marketInfo);
    const marketData = new PolymarketMarketData(client);

    const binding = await marketData.fetchSelectedEvent("event-1", [term]);

    expect(binding.markets).toHaveLength(1);
    expect(binding.markets[0]).toMatchObject({
      id: "mention-market",
      tokens: { yes: "yes-token", no: "no-token" },
      tickSize: 0.01,
      minimumOrderSize: 5,
      acceptingOrders: true,
    });
    expect(binding.rulesHash).toMatch(/^[a-f0-9]{64}$/);
  });

  it("fails loudly when an operator-selected market is absent", async () => {
    const client = fakeClient(
      { id: "event-1", title: "Speech", markets: [] } as unknown as Event,
      {} as MarketInfo,
    );

    await expect(
      new PolymarketMarketData(client).fetchSelectedEvent("event-1", [term]),
    ).rejects.toThrow(/absent/);
  });
});

function fakeClient(event: Event, marketInfo: MarketInfo): PolymarketReadClient {
  return {
    fetchEvent: async () => event,
    fetchMarketInfo: async () => marketInfo,
    fetchOrderBook: async () => ({} as OrderBook),
  };
}
