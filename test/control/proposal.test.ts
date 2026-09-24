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

    await expect(proposer.propose("event-1")).rejects.toThrow(/no unambiguous mention/);
  });

  it("admits an at-least count market and splits its slash alternatives", async () => {
    const countEvent = {
      id: "event-1",
      title: "Speech",
      markets: [
        market(
          "magnitude",
          "Million / Billion / Trillion 10+ times",
          "Will the speaker mention Million, Billion, or Trillion 10+ times?",
        ),
      ],
    } as unknown as Event;
    const proposer = new PolymarketEventProposer(fakeClient(countEvent));

    const proposal = await proposer.propose("event-1");

    expect(proposal.markets).toHaveLength(1);
    expect(proposal.markets[0]?.term).toMatchObject({
      label: "Million / Billion / Trillion",
      acceptedForms: ["Million", "Billion", "Trillion"],
      mentionThreshold: 10,
    });
  });

  it("rejects a count market whose question bounds the count from above", async () => {
    const boundedEvent = {
      id: "event-1",
      title: "Speech",
      markets: [
        market(
          "bounded",
          "Beta 10+ times",
          "Will the speaker mention Beta at most 10 times?",
        ),
      ],
    } as unknown as Event;
    const proposer = new PolymarketEventProposer(fakeClient(boundedEvent));

    await expect(proposer.propose("event-1")).rejects.toThrow(/no unambiguous mention/);
  });

  it("resolves a Polymarket event URL before loading market details", async () => {
    const client = fakeClient(event());
    let requestedUrl: string | undefined;
    client.fetchEventByUrl = async ({ url }) => {
      requestedUrl = url;
      return event();
    };
    const proposer = new PolymarketEventProposer(client);
    const eventUrl = "https://polymarket.com/event/speech";

    const proposal = await proposer.propose(eventUrl);

    expect(requestedUrl).toBe(eventUrl);
    expect(proposal.eventId).toBe("event-1");
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
