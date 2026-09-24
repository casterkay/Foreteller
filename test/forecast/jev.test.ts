import { describe, expect, it, vi } from "vitest";

import type { MarketDefinition } from "../../src/domain/types.js";
import {
  InvalidJevResponseError,
  JevForecaster,
  JevTimeoutError,
  type ForecastSnapshot,
  type JevRequest,
  type JevTransport,
} from "../../src/forecast/jev.js";

function market(marketId: string): MarketDefinition {
  return Object.freeze({
    eventId: "event",
    marketId,
    question: `Will the speaker mention ${marketId}?`,
    description: `Resolves YES if ${marketId} is mentioned`,
    yesTokenId: `yes-${marketId}`,
    noTokenId: `no-${marketId}`,
    tickSize: 0.01,
    minimumOrderSize: 5,
    negRisk: false,
    acceptingOrders: true,
    feeRate: 0.02,
    term: {
      marketId,
      label: marketId,
      acceptedForms: [marketId],
      excludedForms: [],
      speakerScope: "primary",
      windowStartMs: 0,
      windowEndMs: 60_000,
    },
  } satisfies MarketDefinition);
}

function snapshot(overrides: Partial<ForecastSnapshot> = {}): ForecastSnapshot {
  return Object.freeze({
    snapshotAtMs: 1_000,
    eventTitle: "Policy address",
    eventRules: "Named speaker, direct English audio.",
    speaker: "Ada Lovelace",
    eventPhase: "opening remarks",
    elapsedMs: 10_000,
    estimatedRemainingMs: 50_000,
    transcriptCutoffMs: 9_500,
    recentTranscript: "Thank you for joining us.",
    earlierSummary: "The speaker greeted the audience.",
    markets: [market("AI"), market("robots")],
    matchedMarketIds: new Set(["robots"]),
    ...overrides,
  });
}

function response(probability = 0.73): unknown {
  return {
    model: "jev-1.13.0",
    answers: { market_0: { type: "noul", noul: probability } },
    usage: { input_tokens: 100, output_tokens: 10 },
  };
}

function deferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
} {
  let resolvePromise: ((value: T) => void) | undefined;
  const promise = new Promise<T>((resolve) => {
    resolvePromise = resolve;
  });
  return {
    promise,
    resolve: (value) => resolvePromise?.(value),
  };
}

describe("JevForecaster", () => {
  it("batches one price-blind Noul per unmatched market", async () => {
    let captured: JevRequest | undefined;
    const transport: JevTransport = {
      request: async (request) => {
        captured = request;
        return response();
      },
    };
    const forecaster = new JevForecaster({
      transport,
      timeoutMs: 1_000,
      maximumForecastAgeMs: 20_000,
      clock: { now: () => 1_100 },
    });

    const result = await forecaster.forecast(
      snapshot(),
      new AbortController().signal,
    );

    expect(result.status).toBe("completed");
    if (result.status !== "completed") throw new Error("Expected completion");
    expect(result.answers).toEqual([
      {
        marketId: "AI",
        probability: 0.73,
        model: "jev-1.13.0",
        snapshotAtMs: 1_000,
        latencyMs: 0,
      },
    ]);
    expect(Object.keys(captured?.questions ?? {})).toEqual(["market_0"]);
    const encoded = JSON.stringify(captured);
    expect(encoded).not.toContain("yesTokenId");
    expect(encoded).not.toContain("tickSize");
    expect(encoded).not.toContain("feeRate");
    expect(encoded).not.toContain("robots");
  });

  it("sends every revision immediately even while previous requests are pending", async () => {
    const pending = deferred<unknown>();
    let calls = 0;
    const forecaster = new JevForecaster({
      transport: { request: () => { calls += 1; return pending.promise; } },
      timeoutMs: 1_000,
      maximumForecastAgeMs: 20_000,
      clock: { now: () => 1_100 },
    });
    const signal = new AbortController().signal;
    const first = forecaster.forecast(snapshot(), signal);
    const second = forecaster.forecast(snapshot({ recentTranscript: "A new revision" }), signal);
    expect(calls).toBe(2);
    pending.resolve(response());
    expect((await first).status).toBe("completed");
    expect((await second).status).toBe("completed");
    expect((await forecaster.forecast(snapshot(), signal)).status).toBe("completed");
    expect(calls).toBe(3);
  });

  it("rejects malformed and incomplete response batches", async () => {
    const transport: JevTransport = {
      request: async () => ({
        model: "jev-1.13.0",
        answers: { market_0: { type: "noul", noul: 1.01 } },
        usage: { input_tokens: 1, output_tokens: 1 },
      }),
    };
    const forecaster = new JevForecaster({
      transport,
      timeoutMs: 1_000,
      maximumForecastAgeMs: 20_000,
      clock: { now: () => 1_100 },
    });

    await expect(
      forecaster.forecast(snapshot(), new AbortController().signal),
    ).rejects.toBeInstanceOf(InvalidJevResponseError);
  });

  it("does not request forecasts after the event window ends", async () => {
    const request = vi.fn(async () => response());
    const forecaster = new JevForecaster({
      transport: { request },
      timeoutMs: 1_000,
      maximumForecastAgeMs: 20_000,
      clock: { now: () => 1_100 },
    });

    await expect(
      forecaster.forecast(
        snapshot({ eventPhase: "ended", estimatedRemainingMs: 0 }),
        new AbortController().signal,
      ),
    ).resolves.toEqual({ status: "skipped", reason: "event_ended" });
    expect(request).not.toHaveBeenCalled();
  });

  it("skips stale inputs and discards responses that become stale", async () => {
    let now = 2_001;
    let calls = 0;
    const pending = deferred<unknown>();
    const transport: JevTransport = {
      request: () => {
        calls += 1;
        return pending.promise;
      },
    };
    const forecaster = new JevForecaster({
      transport,
      timeoutMs: 10_000,
      maximumForecastAgeMs: 1_000,
      clock: { now: () => now },
    });

    expect(
      await forecaster.forecast(snapshot(), new AbortController().signal),
    ).toEqual({ status: "skipped", reason: "stale_snapshot" });
    expect(calls).toBe(0);

    now = 3_000;
    const active = forecaster.forecast(
      snapshot({ snapshotAtMs: 3_000 }),
      new AbortController().signal,
    );
    now = 4_001;
    pending.resolve(response());
    expect(await active).toEqual({
      status: "discarded",
      reason: "stale_response",
      requestedAtMs: 3_000,
      completedAtMs: 4_001,
    });
  });

  it("enforces a total timeout even when the transport does not settle", async () => {
    vi.useFakeTimers();
    try {
      const transport: JevTransport = {
        request: () => new Promise(() => undefined),
      };
      const forecaster = new JevForecaster({
        transport,
        timeoutMs: 100,
        maximumForecastAgeMs: 20_000,
        clock: { now: () => 1_000 },
      });
      const result = forecaster.forecast(
        snapshot(),
        new AbortController().signal,
      );
      const rejection = expect(result).rejects.toBeInstanceOf(JevTimeoutError);
      await vi.advanceTimersByTimeAsync(100);
      await rejection;
    } finally {
      vi.useRealTimers();
    }
  });
});
