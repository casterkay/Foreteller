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
const countMarketPattern = /\b(?:at least|at most|more than|less than|fewer than|exactly|between)\b|\b\d+\s*\+?\s*(?:times?|mentions?|occurrences?)\b|\b(?:times?|mentions?|occurrences?)\s*\d+\b/iu;

/** An outcome label such as "Million / Billion / Trillion 10+ times". */
const thresholdTitlePattern = /^(?<term>.+?)\s+(?<threshold>\d{1,4})\s*\+\s*times$/iu;

/** Bounds YES-only sizing cannot express, whatever the outcome label claims. */
const nonMonotoneCountPattern = /\b(?:at most|no more than|fewer than|less than|under|exactly|between)\b/iu;

const maximumMentionThreshold = 100;

interface ParsedTerm {
  readonly label: string;
  readonly acceptedForms: readonly string[];
  readonly mentionThreshold: number;
}

export class PolymarketEventProposer {
  public constructor(
    private readonly client: PolymarketReadClient,
    private readonly marketData = new PolymarketMarketData(client),
  ) {}

  public async propose(eventId: string): Promise<EventProposal> {
    requireText(eventId, "event ID");
    const isUrl = /^https:\/\/(?:www\.)?polymarket\.com\/event\/[^/?#]+(?:[/?#]|$)/u.test(eventId);
    const event = isUrl
      ? await this.fetchEventUrl(eventId)
      : await this.client.fetchEvent({ id: eventId });
    if (!isUrl && event.id !== eventId) {
      throw new Error(`Polymarket returned event ${event.id} for requested event ${eventId}`);
    }

    const resolvedEventId = requireText(event.id, "Polymarket event ID");
    const eventTitle = requireText(event.title, `Event ${resolvedEventId} title`);
    const terms = event.markets.flatMap((market) => termForMarket(market));
    if (terms.length === 0) {
      throw new Error(`Event ${eventTitle} has no unambiguous mention markets`);
    }

    const selected = await this.marketData.fetchSelectedEvent(resolvedEventId, terms);
    return proposalFromSelected(selected);
  }

  private fetchEventUrl(eventUrl: string): Promise<Event> {
    if (this.client.fetchEventByUrl === undefined) {
      throw new Error("Polymarket event URL lookup is unavailable");
    }
    return this.client.fetchEventByUrl({ url: eventUrl });
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
  const parsed = parseTermTitle(market.groupItemTitle);
  if (
    market.state.acceptingOrders !== true ||
    parsed === undefined ||
    !questionMatchesThreshold(market.question, parsed.mentionThreshold)
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
      label: parsed.label,
      acceptedForms: parsed.acceptedForms,
      excludedForms: Object.freeze([]),
      speakerScope: "primary",
      windowStartMs,
      windowEndMs,
      mentionThreshold: parsed.mentionThreshold,
    }),
  ];
}

/**
 * Reads an outcome label as alternative accepted forms and, for a count market,
 * the mentions its threshold requires. Anything else stays unproposed: a
 * misread rule is worse than a missed market.
 */
function parseTermTitle(value: string | null | undefined): ParsedTerm | undefined {
  if (value === undefined || value === null) return undefined;
  const title = value.normalize("NFKC").trim().replace(/\s+/gu, " ");
  if (title.length === 0 || title.length > 96) return undefined;

  // Count markets read their threshold from the title; the slash then separates
  // alternative spoken forms, any one of which qualifies.
  const threshold = thresholdTitlePattern.exec(title);
  if (threshold !== null) {
    const mentionThreshold = Number(threshold.groups?.["threshold"] ?? Number.NaN);
    if (
      !Number.isInteger(mentionThreshold) ||
      mentionThreshold < 1 ||
      mentionThreshold > maximumMentionThreshold
    ) {
      return undefined;
    }
    const acceptedForms = (threshold.groups?.["term"] ?? "").split("/").map(normalizedSimpleTerm);
    if (acceptedForms.length === 0 || acceptedForms.some((form) => form === undefined)) {
      return undefined;
    }
    const forms = Object.freeze(acceptedForms as readonly string[]);
    return Object.freeze({
      label: forms.join(" / "),
      acceptedForms: forms,
      mentionThreshold,
    });
  }

  // A plain mention market stays strictly single-term; slashes and conjunctions
  // remain ambiguous without a count qualifier to disambiguate them.
  const label = normalizedSimpleTerm(title);
  if (label === undefined) return undefined;
  return Object.freeze({
    label,
    acceptedForms: Object.freeze([label]),
    mentionThreshold: 1,
  });
}

function normalizedSimpleTerm(value: string): string | undefined {
  const title = value.trim().replace(/\s+/gu, " ");
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

/**
 * The outcome label alone must never decide how many mentions resolve a market:
 * the question has to agree, and must not bound the count from above.
 */
function questionMatchesThreshold(
  question: string | null | undefined,
  mentionThreshold: number,
): boolean {
  const text = question ?? "";
  if (mentionThreshold === 1) return !countMarketPattern.test(text);
  if (nonMonotoneCountPattern.test(text)) return false;
  const count = String(mentionThreshold);
  return (
    new RegExp(`\\b${count}\\s*\\+`, "u").test(text) ||
    new RegExp(`\\b(?:at least\\s+)?${count}\\s+(?:or more\\s+)?(?:times|mentions|occurrences)\\b`, "iu").test(text)
  );
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
