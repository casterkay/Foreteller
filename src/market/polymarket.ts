import { createHash } from "node:crypto";

import {
  createPublicClient,
  type Event,
  type MarketInfo,
  type OrderBook,
} from "@polymarket/client";
import { fetchEvent, fetchMarketInfo } from "@polymarket/client/actions";

import type { TermSpec } from "../domain/types.js";
import type { EventMarkets, FeeSchedule, MarketTokens, SelectedMarket } from "./types.js";

export interface PolymarketReadClient {
  fetchEvent(request: { readonly id: string }): Promise<Event>;
  fetchMarketInfo(request: { readonly conditionId: string }): Promise<MarketInfo>;
  fetchOrderBook(request: { readonly assetId: string }): Promise<OrderBook>;
}

export function createPolymarketReadClient(): PolymarketReadClient {
  const client = createPublicClient();
  return Object.freeze({
    fetchEvent: (request: { readonly id: string }) => fetchEvent(client, request),
    fetchMarketInfo: (request: { readonly conditionId: string }) =>
      fetchMarketInfo(client, request),
    fetchOrderBook: (request: { readonly assetId: string }) => client.fetchOrderBook(request),
  });
}

export class PolymarketMarketData {
  public constructor(private readonly client: PolymarketReadClient) {}

  public async fetchSelectedEvent(
    eventId: string,
    terms: readonly TermSpec[],
  ): Promise<EventMarkets> {
    validateEventId(eventId);
    const termsByMarketId = indexTerms(terms);
    const event = await this.client.fetchEvent({ id: eventId });
    validateEvent(event, eventId);

    const selected = event.markets.filter((market) => termsByMarketId.has(market.id));
    if (selected.length !== termsByMarketId.size) {
      const found = new Set<string>(selected.map((market) => market.id));
      const missing = [...termsByMarketId.keys()].filter((id) => !found.has(id));
      throw new Error(`Selected market IDs are absent from event ${eventId}: ${missing.join(", ")}`);
    }

    const details = await Promise.all(
      selected.map(async (market) => {
        if (market.conditionId === null) {
          throw new Error(`Market ${market.id} has no condition ID`);
        }
        const marketInfo = await this.client.fetchMarketInfo({
          conditionId: market.conditionId,
        });
        return { market, marketInfo };
      }),
    );

    const markets = details.map(({ market, marketInfo }) =>
      normalizeMarket(market, marketInfo, termsByMarketId.get(market.id)!),
    );
    const title = requiredText(event.title, `Event ${eventId} title`);
    return Object.freeze({
      eventId,
      title,
      rulesHash: hashRules(eventId, title, markets),
      markets: Object.freeze(markets),
    });
  }
}

function normalizeMarket(
  market: Event["markets"][number],
  marketInfo: MarketInfo,
  term: TermSpec,
): SelectedMarket {
  const tokens = selectBinaryTokens(marketInfo, market.id);
  const minimumOrderSize = requiredPositiveNumber(
    market.trading.minimumOrderSize,
    `Market ${market.id} minimum order size`,
  );
  const tickSize = requiredPositiveNumber(marketInfo.tickSize, `Market ${market.id} tick size`);
  const feeSchedule = normalizeFeeSchedule(marketInfo.feeInfo, market.id);

  return Object.freeze({
    id: market.id,
    question: requiredText(market.question, `Market ${market.id} question`),
    description: requiredText(market.description, `Market ${market.id} description`),
    term,
    tokens,
    tickSize,
    minimumOrderSize,
    feeSchedule,
    negRisk: marketInfo.negRisk,
    acceptingOrders: market.state.acceptingOrders === true,
  });
}

function selectBinaryTokens(marketInfo: MarketInfo, marketId: string): MarketTokens {
  const byOutcome = new Map(
    marketInfo.tokens.map((token) => [token.outcome.trim().toLocaleLowerCase("en-US"), token.assetId]),
  );
  const yes = byOutcome.get("yes");
  const no = byOutcome.get("no");
  if (yes === undefined || no === undefined) {
    throw new Error(`Market ${marketId} does not expose both YES and NO tokens`);
  }
  return Object.freeze({ yes, no });
}

function normalizeFeeSchedule(
  feeInfo: MarketInfo["feeInfo"],
  marketId: string,
): FeeSchedule | undefined {
  const rate = requiredNonNegativeNumber(feeInfo.rate, `Market ${marketId} fee rate`);
  const exponent = requiredNonNegativeNumber(
    feeInfo.exponent,
    `Market ${marketId} fee exponent`,
  );
  return rate === 0 ? undefined : Object.freeze({ rate, exponent });
}

function hashRules(eventId: string, title: string, markets: readonly SelectedMarket[]): string {
  const rules = markets
    .map((market) => ({
      id: market.id,
      question: market.question,
      description: market.description,
      term: {
        acceptedForms: market.term.acceptedForms,
        excludedForms: market.term.excludedForms,
        speakerScope: market.term.speakerScope,
        windowStartMs: market.term.windowStartMs,
        windowEndMs: market.term.windowEndMs,
      },
    }))
    .sort((left, right) => left.id.localeCompare(right.id));
  return createHash("sha256")
    .update(JSON.stringify({ eventId, title, markets: rules }))
    .digest("hex");
}

function indexTerms(terms: readonly TermSpec[]): ReadonlyMap<string, TermSpec> {
  if (terms.length === 0) throw new Error("At least one explicit TermSpec is required");
  const byMarketId = new Map<string, TermSpec>();
  for (const term of terms) {
    validateTerm(term);
    if (byMarketId.has(term.marketId)) {
      throw new Error(`Duplicate TermSpec for market ${term.marketId}`);
    }
    byMarketId.set(term.marketId, term);
  }
  return byMarketId;
}

function validateTerm(term: TermSpec): void {
  requiredText(term.marketId, "TermSpec market ID");
  if (term.acceptedForms.length === 0) {
    throw new Error(`TermSpec ${term.marketId} needs at least one accepted form`);
  }
  if (!Number.isFinite(term.windowStartMs) || !Number.isFinite(term.windowEndMs)) {
    throw new Error(`TermSpec ${term.marketId} has an invalid qualifying window`);
  }
}

function validateEvent(event: Event, expectedId: string): void {
  if (event.id !== expectedId) {
    throw new Error(`Polymarket returned event ${event.id} for requested event ${expectedId}`);
  }
}

function validateEventId(eventId: string): void {
  requiredText(eventId, "Event ID");
}

function requiredText(value: string | null | undefined, field: string): string {
  if (value === null || value === undefined || value.trim().length === 0) {
    throw new Error(`${field} is required`);
  }
  return value;
}

function requiredPositiveNumber(value: string | number | null | undefined, field: string): number {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) throw new Error(`${field} must be positive`);
  return number;
}

function requiredNonNegativeNumber(
  value: string | number | null | undefined,
  field: string,
): number {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) throw new Error(`${field} must be non-negative`);
  return number;
}
