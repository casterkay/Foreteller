import { describe, expect, it } from "vitest";

import type { ForecastMarket } from "../../src/forecast/index.js";
import { PanelState } from "../../src/panel/index.js";

const market: ForecastMarket = Object.freeze({
  marketId: "market-1",
  question: "Will the speaker say alpha?",
  description: "A future mention of alpha.",
  term: Object.freeze({
    marketId: "market-1",
    label: "alpha",
    acceptedForms: Object.freeze(["alpha"]),
    excludedForms: Object.freeze([]),
    speakerScope: "primary",
  }),
});

describe("PanelState", () => {
  it("publishes immutable snapshots without inventing a PM price", () => {
    const state = new PanelState();
    state.begin("custom", "Test event", [market], 1_000, "jev_only");
    state.markLive();
    state.recordTranscript(2_000);
    state.recordForecasts([
      Object.freeze({
        marketId: "market-1",
        probability: 0.72,
        model: "jev-test",
        snapshotAtMs: 1_900,
        latencyMs: 100,
      }),
    ], 2_100);

    const first = state.snapshot();
    expect(first.markets).toEqual([
      expect.objectContaining({
        term: "alpha",
        polymarketYesPrice: null,
        jevProbability: 0.72,
      }),
    ]);

    state.recordPrice("market-1", 0.61, 2_200);
    expect(first.markets[0]?.polymarketYesPrice).toBeNull();
    expect(state.snapshot().markets[0]?.polymarketYesPrice).toBe(0.61);
  });

  it("computes update frequency from successful forecast completions", () => {
    const state = new PanelState();
    state.begin("event", "Test event", [market], 1_000, "full_event");
    const forecast = Object.freeze({
      marketId: "market-1",
      probability: 0.6,
      model: "jev-test",
      snapshotAtMs: 1_000,
      latencyMs: 50,
    });

    state.recordForecasts([forecast], 2_000);
    state.recordForecasts([forecast], 7_000);

    expect(state.snapshot().forecastUpdateHz).toBeCloseTo(0.2);
  });

  it("ignores late updates for a retired market but rejects unknown markets", () => {
    const state = new PanelState();
    state.begin("event", "Test event", [market], 1_000, "full_event");
    state.removeMarket("market-1");

    expect(() => state.recordPrice("market-1", 0.8, 2_000)).not.toThrow();
    expect(() => state.recordForecasts([Object.freeze({
      marketId: "market-1",
      probability: 0.8,
      model: "jev-test",
      snapshotAtMs: 1_900,
      latencyMs: 100,
    })], 2_000)).not.toThrow();
    expect(() => state.recordPrice("unknown", 0.8, 2_000)).toThrow(/Unknown panel market/);
    expect(state.snapshot().forecastUpdateHz).toBe(0);
  });
});
