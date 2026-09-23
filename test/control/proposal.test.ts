import { describe, expect, it } from "vitest";

import type { Event, MarketInfo, OrderBook } from "@polymarket/client";

import { PolymarketEventProposer } from "../../src/control/proposal.js";
import type { PolymarketReadClient } from "../../src/market/polymarket.js";

const start = "2026-09-22T12:00:00.000Z";
const end = "2026-09-22T13:00:00.000Z";

describe("PolymarketEventProposer", () => {
  it("proposes only unambiguous terms with usable individual market windows", async () => {
    const proposer = new PolymarketEventProposer(fakeClient(event()));

    const proposal = await proposer.propose("event-1");

    expect(proposal.eventTitle).toBe("Speech");
    expect(proposal.markets).toHaveLength(1);
    expect(proposal.markets[0]).toMatchObject({
      eventId: "event-1",
      marketId: "alpha",
      term: {
        label: "Alpha",
        acceptedForms: ["Alpha"],
        windowStartMs: Date.parse(start),
        windowEndMs: Date.parse(end),
      },
    });
    expect(proposal.expectedStartMs).toBe(Date.parse(start));
    expect(proposal.expectedEndMs).toBe(Date.parse(end));
  });

  it("fails when the event has no safe single-mention markets", async () => {
    const unsafe = event().markets.filter((market) => market.id !== "alpha");
    const proposer = new PolymarketEventProposer(
      fakeClient({ id: "event-1", title: "Speech", markets: unsafe } as unknown as Event),
    );

    await expect(proposer.propose("event-1")).rejects.toThrow(/no unambiguous single-mention/);
  });
});

function event(): Event {
  return {
    id: "event-1",
    title: "Speech",
    markets: [
      market("alpha", "Alpha"),
      market("no-qualifier", "-No Qualifying Event-"),
      market("choice", "Alpha/Beta"),
      market("count", "Beta", "Will the speaker say Beta at least 2 times?"),
      market("no-window", "Gamma", "Will the speaker say Gamma?", null, end),
    ],
  } as unknown as Event;
}

function market(
  id: string,
  groupItemTitle: string,
  question = `Will the speaker say ${groupItemTitle}?`,
  startDate: string | null = start,
  endDate: string | null = end,
): unknown {
  return {
    id,
    conditionId: `condition-${id}`,
    groupItemTitle,
    question,
    description: "A single mention between market creation and close resolves YES.",
    state: { acceptingOrders: true, startDate, endDate },
    trading: { minimumOrderSize: "1" },
  };
}

function fakeClient(eventValue: Event): PolymarketReadClient {
  const marketInfo = {
    feeInfo: { rate: 0, exponent: 1 },
    negRisk: false,
    tickSize: 0.01,
    tokens: [
      { outcome: "Yes", assetId: "yes-token" },
      { outcome: "No", assetId: "no-token" },
    ],
  } as unknown as MarketInfo;
  return {
    fetchEvent: async () => eventValue,
    fetchMarketInfo: async () => marketInfo,
    fetchOrderBook: async () => ({} as OrderBook),
  };
}
