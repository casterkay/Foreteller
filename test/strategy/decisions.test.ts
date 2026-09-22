import { describe, expect, it } from "vitest";

import { defaultLimits } from "../../src/config.js";
import type { BookSnapshot, ForecastAnswer, MarketDefinition, MentionHit } from "../../src/domain/types.js";
import { decideForecastOrder, decideSniperOrder } from "../../src/strategy/index.js";

const nowMs = Date.UTC(2026, 8, 22, 12);

const market: MarketDefinition = {
  eventId: "event-1",
  marketId: "market-1",
  question: "Will the speaker say alpha?",
  description: "Single mention market",
  yesTokenId: "yes-1",
  noTokenId: "no-1",
  tickSize: 0.01,
  minimumOrderSize: 1,
  negRisk: false,
  acceptingOrders: true,
  feeRate: 0.1,
  term: {
    marketId: "market-1",
    label: "alpha",
    acceptedForms: ["alpha"],
    excludedForms: [],
    speakerScope: "primary",
    windowStartMs: nowMs - 60_000,
    windowEndMs: nowMs + 60_000,
  },
};

const mention: MentionHit = {
  marketId: "market-1",
  term: "alpha",
  transcript: "alpha",
  sourceStartMs: nowMs - 1_000,
  sourceEndMs: nowMs - 900,
  minimumConfidence: 0.95,
  segmentIds: ["segment-1"],
};

function book(asks: readonly { readonly price: number; readonly size: number }[]): BookSnapshot {
  return {
    tokenId: "yes-1",
    bids: [],
    asks,
    tickSize: 0.01,
    receivedAtMs: nowMs - 100,
    synchronized: true,
  };
}

function forecast(overrides: Partial<ForecastAnswer> = {}): ForecastAnswer {
  return {
    marketId: "market-1",
    probability: 0.8,
    model: "test",
    snapshotAtMs: nowMs - 100,
    latencyMs: 50,
    ...overrides,
  };
}

describe("decideSniperOrder", () => {
  it("bounds a FAK buy by the cap, slippage, allowance, and executable depth", () => {
    const decision = decideSniperOrder({
      market,
      book: book([
        { price: 0.97, size: 3 },
        { price: 0.98, size: 20 },
      ]),
      mention,
      nowMs,
      remainingAllowance: 5,
      attempts: 0,
      lastAttemptAtMs: undefined,
      limits: defaultLimits,
    });

    expect(decision).toMatchObject({ accepted: true, strategy: "sniper", maxPrice: 0.98 });
    if (decision.accepted) {
      expect(decision.notional).toBeCloseTo(5, 6);
      expect(decision.estimate.complete).toBe(true);
    }
  });

  it("rejects a repeat before its cooldown or after its bounded attempts", () => {
    const common = {
      market,
      book: book([{ price: 0.9, size: 100 }]),
      mention,
      nowMs,
      remainingAllowance: 20,
      limits: defaultLimits,
    };
    expect(decideSniperOrder({ ...common, attempts: 1, lastAttemptAtMs: nowMs - 1 })).toMatchObject({
      accepted: false,
      reason: "cooldown",
    });
    expect(decideSniperOrder({ ...common, attempts: 5, lastAttemptAtMs: undefined })).toMatchObject({
      accepted: false,
      reason: "attempt_limit",
    });
  });

  it("does not recommend an order from a stale or unsynchronized book", () => {
    const stale = { ...book([{ price: 0.9, size: 100 }]), receivedAtMs: nowMs - 45_001 };
    const input = {
      market,
      mention,
      nowMs,
      remainingAllowance: 20,
      attempts: 0,
      lastAttemptAtMs: undefined,
      limits: defaultLimits,
    };
    expect(decideSniperOrder({ ...input, book: stale })).toMatchObject({ reason: "book_stale" });
    expect(decideSniperOrder({ ...input, book: { ...book([]), synchronized: false } })).toMatchObject({
      reason: "book_unsynchronized",
    });
  });
});

describe("decideForecastOrder", () => {
  it("uses fee-aware full-depth cost and a max price that preserves the required edge", () => {
    const decision = decideForecastOrder({
      market,
      book: book([
        { price: 0.5, size: 3 },
        { price: 0.51, size: 20 },
      ]),
      forecast: forecast(),
      feeSchedule: { rate: 0.1, exponent: 1 },
      marketAlreadyMatched: false,
      nowMs,
      remainingAllowance: 15,
      lastAttemptAtMs: undefined,
      limits: defaultLimits,
    });

    expect(decision).toMatchObject({ accepted: true, strategy: "forecast", maxPrice: 0.65 });
    if (decision.accepted) {
      expect(decision.notional).toBeLessThanOrEqual(5);
      expect(decision.estimate.totalCost).toBeLessThanOrEqual(5);
      expect(0.8 - decision.maxPrice - 0.023).toBeGreaterThanOrEqual(0.12);
      expect(0.8 - (decision.estimate.averageCostPerShare ?? 1)).toBeGreaterThanOrEqual(0.12);
    }
  });

  it("rejects stale forecasts, already matched markets, and insufficient depth", () => {
    const common = {
      market,
      book: book([{ price: 0.5, size: 100 }]),
      feeSchedule: { rate: 0.1, exponent: 1 },
      nowMs,
      remainingAllowance: 15,
      lastAttemptAtMs: undefined,
      limits: defaultLimits,
    };
    expect(
      decideForecastOrder({
        ...common,
        forecast: forecast({ snapshotAtMs: nowMs - 20_001 }),
        marketAlreadyMatched: false,
      }),
    ).toMatchObject({ reason: "forecast_stale" });
    expect(
      decideForecastOrder({ ...common, forecast: forecast(), marketAlreadyMatched: true }),
    ).toMatchObject({ reason: "market_already_matched" });
    expect(
      decideForecastOrder({
        ...common,
        book: book([{ price: 0.5, size: 0.5 }]),
        forecast: forecast(),
        marketAlreadyMatched: false,
      }),
    ).toMatchObject({ reason: "below_minimum_order_size" });
  });

  it("rejects when the best ask is outside the reviewed forecast price range", () => {
    const decision = decideForecastOrder({
      market,
      book: book([{ price: 0.91, size: 100 }]),
      forecast: forecast({ probability: 0.99 }),
      feeSchedule: undefined,
      marketAlreadyMatched: false,
      nowMs,
      remainingAllowance: 15,
      lastAttemptAtMs: undefined,
      limits: defaultLimits,
    });
    expect(decision).toMatchObject({ accepted: false, reason: "ask_outside_forecast_range" });
  });
});
