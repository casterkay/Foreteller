import type { Event } from "@polymarket/client";

import type { MarketDefinition, TermSpec } from "../domain/types.js";
import { PolymarketMarketData, type PolymarketReadClient } from "../market/polymarket.js";
import type { EventMarkets, SelectedMarket } from "../market/types.js";

export interface EventProposal {
  readonly eventId: string;
  readonly eventTitle: string;
  readonly expectedStartMs: number;
  readonly expectedEndMs: number;
  readonly rulesHash: string;
  readonly markets: readonly MarketDefinition[];
}

const simpleTermPattern = /^[\p{L}\p{M}][\p{L}\p{M}'\u2019-]*(?:[ ][\p{L}\p{M}][\p{L}\p{M}'\u2019-]*)*$/u;
const countMarketPattern = /\b(?:at least|at most|more than|less than|fewer than|exactly|between)\b|\b\d+\s*(?:times?|mentions?|occurrences?)\b|\b(?:times?|mentions?|occurrences?)\s*\d+\b/iu;

export class PolymarketEventProposer {
  public constructor(
    private readonly client: PolymarketReadClient,
    private readonly marketData = new PolymarketMarketData(client),
  ) {}

  public async propose(eventId: string): Promise<EventProposal> {
    requireText(eventId, "event ID");
    const event = await this.client.fetchEvent({ id: eventId });
    if (event.id !== eventId) {
      throw new Error(`Polymarket returned event ${event.id} for requested event ${eventId}`);
    }

    const eventTitle = requireText(event.title, `Event ${eventId} title`);
    const terms = event.markets.flatMap((market) => termForMarket(market));
    if (terms.length === 0) {
      throw new Error(`Event ${eventTitle} has no unambiguous single-mention markets`);
    }

    const selected = await this.marketData.fetchSelectedEvent(eventId, terms);
    return proposalFromSelected(selected);
  }
}

function proposalFromSelected(selected: EventMarkets): EventProposal {
  const markets = selected.markets.map((market) => toMarketDefinition(selected.eventId, market));
  const starts = markets.map((market) => market.term.windowStartMs);
  const ends = markets.map((market) => market.term.windowEndMs);
  const expectedStartMs = Math.max(...starts);
  const expectedEndMs = Math.min(...ends);
  if (expectedEndMs <= expectedStartMs) {
    throw new Error("Selected markets do not share a qualifying window");
  }

  return Object.freeze({
    eventId: selected.eventId,
    eventTitle: selected.title,
    expectedStartMs,
    expectedEndMs,
    rulesHash: selected.rulesHash,
    markets: Object.freeze(markets),
  });
}

function termForMarket(market: Event["markets"][number]): readonly TermSpec[] {
  const title = normalizedSimpleTerm(market.groupItemTitle);
  if (
    market.state.acceptingOrders !== true ||
    title === undefined ||
    isCountMarket(market.question, market.description)
  ) {
    return [];
  }

  const windowStartMs = parseTimestamp(market.state.startDate);
  const windowEndMs = parseTimestamp(market.state.endDate);
  if (windowStartMs === undefined || windowEndMs === undefined || windowEndMs <= windowStartMs) {
    return [];
  }

  return [
    Object.freeze({
      marketId: market.id,
      label: title,
      acceptedForms: Object.freeze([title]),
      excludedForms: Object.freeze([]),
      speakerScope: "primary",
      windowStartMs,
      windowEndMs,
    }),
  ];
}

function normalizedSimpleTerm(value: string | null | undefined): string | undefined {
  if (value === undefined || value === null) return undefined;
  const title = value.normalize("NFKC").trim().replace(/\s+/gu, " ");
  if (
    title.length === 0 ||
    title.length > 64 ||
    title.localeCompare("-No Qualifying Event-", "en-US", { sensitivity: "accent" }) === 0 ||
    /^no qualifying event$/iu.test(title) ||
    /\b(?:and|or)\b/iu.test(title) ||
    !simpleTermPattern.test(title)
  ) {
    return undefined;
  }
  return title;
}

function isCountMarket(question: string | null | undefined, description: string | null | undefined): boolean {
  return countMarketPattern.test(`${question ?? ""}\n${description ?? ""}`);
}

function parseTimestamp(value: string | null | undefined): number | undefined {
  if (value === undefined || value === null || value.trim().length === 0) return undefined;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : undefined;
}

function toMarketDefinition(eventId: string, market: SelectedMarket): MarketDefinition {
  return Object.freeze({
    eventId,
    marketId: market.id,
    question: market.question,
    description: market.description,
    yesTokenId: market.tokens.yes,
    noTokenId: market.tokens.no,
    tickSize: market.tickSize,
    minimumOrderSize: market.minimumOrderSize,
    negRisk: market.negRisk,
    acceptingOrders: market.acceptingOrders,
    feeRate: market.feeSchedule?.rate ?? 0,
    ...(market.feeSchedule === undefined
      ? {}
      : { feeExponent: market.feeSchedule.exponent }),
    term: market.term,
  });
}

function requireText(value: string | null | undefined, name: string): string {
  if (value === undefined || value === null || value.trim().length === 0) {
    throw new Error(`${name} is required`);
  }
  return value;
}
