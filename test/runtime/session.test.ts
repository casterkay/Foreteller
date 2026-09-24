import type { OrderBook } from "@polymarket/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { defaultLimits } from "../../src/config.js";
import type { Logger } from "../../src/core/log.js";
import type { SessionBinding, TranscriptSegment } from "../../src/domain/types.js";
import { DisabledVenueTrader, SerializedExecutor } from "../../src/execution/index.js";
import type {
  ForecastBatchResult,
  ForecastSnapshot,
} from "../../src/forecast/index.js";
import type {
  MarketStreamEvent,
  MarketSubscriptionClient,
  MarketSubscriptionHandle,
} from "../../src/market/subscription.js";
import {
  LiveSessionRuntime,
  effectiveTiming,
  type SessionForecaster,
} from "../../src/runtime/index.js";
import { SqliteStore } from "../../src/storage/index.js";
import type {
  AudioSource,
  StreamingTranscriber,
  TranscriptEvent,
} from "../../src/transcript/index.js";

describe("session audio timing", () => {
  it("continues aging the last transcript while no new audio result arrives", () => {
    expect(
      effectiveTiming(
        {
          observedAgeMs: 100,
          observedAgeBasis: "pipeline_clock",
          observedAtMs: 1_000,
        },
        46_000,
      ),
    ).toEqual({
      observedAgeMs: 45_100,
      observedAgeBasis: "pipeline_clock",
      observedAtMs: 1_000,
    });
  });
});

describe("LiveSessionRuntime", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("ends the session and waits for worker cleanup at the event boundary", async () => {
    vi.useFakeTimers();
    const now = Date.UTC(2026, 8, 22, 12);
    vi.setSystemTime(now);
    const harness = createHarness({ expectedEndMs: now + 100 });

    await harness.runtime.start(harness.binding);
    await vi.advanceTimersByTimeAsync(0);
    await harness.transcriber.ready;
    await vi.advanceTimersByTimeAsync(1_000);

    await expect(harness.runtime.status(harness.binding)).resolves.toBe("ended");
    expect(harness.store.sessionFacts(harness.binding.sessionId).status).toBe("ended");
    await harness.runtime.shutdown();
    expect(harness.subscription.closed).toBe(true);
    harness.store.close();
  });

  it("periodically reconciles unresolved execution state while live", async () => {
    const harness = createHarness({ reconcileIntervalMs: 10 });
    const reconcile = vi.spyOn(harness.executor, "reconcile");

    await harness.runtime.start(harness.binding);
    await harness.transcriber.ready;
    await vi.waitFor(() => expect(reconcile).toHaveBeenCalled());

    await harness.runtime.halt(harness.binding);
    harness.store.close();
  });

  it("halts when the transcription source ends before the event window", async () => {
    const harness = createHarness();

    await harness.runtime.start(harness.binding);
    await harness.transcriber.ready;
    harness.transcriber.finish();

    await vi.waitFor(async () => {
      await expect(harness.runtime.status(harness.binding)).resolves.toBe("halted");
    });
    await harness.runtime.shutdown();
    expect(harness.store.sessionFacts(harness.binding.sessionId).status).toBe("halted");
    harness.store.close();
  });

  it("preserves an operator halt while waiting for the feed to start", async () => {
    const harness = createHarness({ liveStatus: "is_upcoming" });

    await harness.runtime.start(harness.binding);
    await harness.runtime.halt(harness.binding);

    await expect(harness.runtime.status(harness.binding)).resolves.toBe("halted");
    expect(harness.store.sessionFacts(harness.binding.sessionId).status).toBe("waiting");
    harness.store.close();
  });

  it("applies a transcript hit before a forecast that was already in flight", async () => {
    const forecaster = new ControlledForecaster();
    const harness = createHarness({ forecaster });
    await harness.runtime.start(harness.binding);
    await harness.transcriber.ready;

    harness.transcriber.emit(transcriptEvent(harness.binding, false, "context"));
    await flushTasks();
    harness.subscription.push({
      type: "book",
      payload: {
        assetId: "yes-token",
        bids: [{ price: "0.49", size: "100" }],
        asks: [{ price: "0.51", size: "100" }],
        tickSize: "0.01",
        timestamp: Date.now(),
      },
    });
    await vi.waitFor(() => expect(forecaster.calls).toBe(1));

    harness.transcriber.emit(transcriptEvent(harness.binding, true, "alpha"));
    await vi.waitFor(() => {
      expect(harness.store.sessionFacts(harness.binding.sessionId).decisions[0]?.strategy)
        .toBe("sniper");
    });

    forecaster.complete();
    await vi.waitFor(() => {
      expect(harness.store.sessionFacts(harness.binding.sessionId).decisions).toHaveLength(2);
    });
    const facts = harness.store.sessionFacts(harness.binding.sessionId);
    expect(facts.decisions.map((decision) => decision.strategy)).toEqual([
      "sniper",
      "forecast",
    ]);
    expect(facts.decisions[1]?.accepted).toBe(false);
    expect(facts.orders.map((order) => order.intent.strategy)).toEqual(["sniper"]);

    await harness.runtime.halt(harness.binding);
    harness.store.close();
  });

  it("flips count-market coverage off after an audio source gap", async () => {
    const forecaster = new CapturingForecaster();
    const harness = createHarness({ forecaster, coverageFromStart: true });
    await harness.runtime.start(harness.binding);
    await harness.transcriber.ready;

    harness.transcriber.emit(transcriptEvent(harness.binding, false, "context"));
    await flushTasks();
    expect(forecaster.snapshots.at(-1)?.mentionCountsComplete).toBe(true);

    harness.transcriber.disconnect();

    harness.transcriber.emit(transcriptEvent(harness.binding, false, "context again"));
    await flushTasks();
    expect(forecaster.snapshots.at(-1)?.mentionCountsComplete).toBe(false);

    await harness.runtime.halt(harness.binding);
    harness.store.close();
  });
});

function createHarness(options: {
  readonly expectedEndMs?: number;
  readonly reconcileIntervalMs?: number;
  readonly forecaster?: SessionForecaster;
  readonly liveStatus?: "is_live" | "is_upcoming";
  readonly coverageFromStart?: boolean;
} = {}) {
  const now = Date.now();
  const binding = sessionBinding(now, options.expectedEndMs ?? now + 60_000);
  const store = new SqliteStore(":memory:");
  store.recordSession(binding.sessionId, "waiting", now);
  store.recordBinding(binding);
  const executor = new SerializedExecutor(store, new DisabledVenueTrader(), {
    liveTrading: false,
    requestTimeoutMs: 100,
    limits: {
      dailyNotionalLimit: defaultLimits.dailyNotionalLimit,
      eventNotionalLimit: defaultLimits.eventNotionalLimit,
      forecastMarketAllowance: defaultLimits.forecastMarketAllowance,
      sniperMarketAllowance: defaultLimits.sniperMarketAllowance,
      maximumSourceAgeMs: defaultLimits.maximumSourceAgeMs,
    },
  });
  const transcriber = new ControlledTranscriber();
  const subscription = new PushSubscription();
  const runtime = new LiveSessionRuntime({
    store,
    executor,
    transcriber,
    forecaster: options.forecaster ?? new SkippedForecaster(),
    subscriberClient: subscription,
    videoProbe: {
      inspect: async () => ({
        videoId: binding.videoId,
        title: "Live speech",
        channelId: binding.channelId,
        liveStatus: options.liveStatus ?? "is_live",
        ...(options.coverageFromStart === true ? { scheduledStartMs: Date.now() } : {}),
      }),
    },
    verifier: { verify: async () => true },
    limits: defaultLimits,
    logger: silentLogger,
    liveTrading: false,
    sessionDataDirectory: "/tmp/foreteller-runtime-test",
    mentionCountCoverageGraceMs: 15_000,
    rulesCheckMs: 100_000,
    reconcileIntervalMs: options.reconcileIntervalMs ?? 100_000,
  });
  return { binding, store, executor, transcriber, subscription, runtime };
}

function sessionBinding(now: number, expectedEndMs: number): SessionBinding {
  const binding: SessionBinding = {
    sessionId: "session-1",
    eventId: "event-1",
    eventTitle: "Speech",
    rulesHash: "rules-1",
    videoUrl: "https://youtube.test/live",
    videoId: "video-1",
    channelId: "channel-1",
    speaker: "Ada",
    primarySpeaker: 0,
    expectedStartMs: now - 1_000,
    expectedEndMs,
    confirmedAtMs: now - 2_000,
    markets: [
      {
        eventId: "event-1",
        marketId: "market-1",
        question: "Will Ada say alpha?",
        description: "One qualifying mention of alpha.",
        yesTokenId: "yes-token",
        noTokenId: "no-token",
        tickSize: 0.01,
        minimumOrderSize: 1,
        negRisk: false,
        acceptingOrders: true,
        feeRate: 0,
        term: {
          marketId: "market-1",
          label: "alpha",
          acceptedForms: ["alpha"],
          excludedForms: [],
          speakerScope: "primary",
          windowStartMs: now - 1_000,
          windowEndMs: expectedEndMs,
          mentionThreshold: 1,
        },
      },
    ],
  };
  return Object.freeze(binding);
}

function transcriptEvent(
  binding: SessionBinding,
  isFinal: boolean,
  text: string,
): TranscriptEvent {
  const receivedAtMs = Date.now();
  const sourceStartMs = receivedAtMs - 100;
  const segment: TranscriptSegment = {
    id: `${isFinal ? "final" : "interim"}-${text}`,
    text,
    words: [{
      text,
      startMs: sourceStartMs,
      endMs: receivedAtMs - 50,
      confidence: 0.99,
      ...(binding.primarySpeaker === undefined ? {} : { speaker: binding.primarySpeaker }),
    }],
    sourceStartMs,
    sourceEndMs: receivedAtMs - 50,
    receivedAtMs,
    isFinal,
  };
  return { segment, observedAgeMs: 50, observedAgeBasis: "pipeline_clock" };
}

class ControlledTranscriber implements StreamingTranscriber {
  private onTranscript: ((event: TranscriptEvent) => void) | undefined;
  private onDiscontinuity: (() => void) | undefined;
  private markReady: (() => void) | undefined;
  private finishRun: (() => void) | undefined;
  public readonly ready = new Promise<void>((resolve) => {
    this.markReady = resolve;
  });

  public run(
    _source: AudioSource,
    onTranscript: (event: TranscriptEvent) => void,
    signal: AbortSignal,
    onDiscontinuity?: () => void,
  ): Promise<void> {
    this.onTranscript = onTranscript;
    this.onDiscontinuity = onDiscontinuity;
    this.markReady?.();
    return new Promise((resolve) => {
      this.finishRun = resolve;
      if (signal.aborted) resolve();
      else signal.addEventListener("abort", () => resolve(), { once: true });
    });
  }

  public disconnect(): void {
    this.onDiscontinuity?.();
  }

  public emit(event: TranscriptEvent): void {
    if (this.onTranscript === undefined) throw new Error("transcriber is not running");
    this.onTranscript(event);
  }

  public finish(): void {
    this.finishRun?.();
  }
}

class PushSubscription implements MarketSubscriptionClient, MarketSubscriptionHandle {
  private readonly events: MarketStreamEvent[] = [];
  private waiter: ((result: IteratorResult<MarketStreamEvent>) => void) | undefined;
  public closed = false;

  public fetchOrderBook(request: { readonly assetId: string }): Promise<OrderBook> {
    return Promise.resolve({
      assetId: request.assetId,
      tokenId: request.assetId,
      conditionId: "condition-1",
      market: "market-1",
      timestamp: Date.now(),
      hash: "book",
      bids: [{ price: "0.49", size: "100" }],
      asks: [{ price: "0.50", size: "100" }],
      minOrderSize: "1",
      tickSize: "0.01",
      negRisk: false,
    } as unknown as OrderBook);
  }

  public subscribe(): Promise<MarketSubscriptionHandle> {
    return Promise.resolve(this);
  }

  public push(event: MarketStreamEvent): void {
    if (this.waiter !== undefined) {
      const waiter = this.waiter;
      this.waiter = undefined;
      waiter({ done: false, value: event });
    } else {
      this.events.push(event);
    }
  }

  public close(): Promise<void> {
    this.closed = true;
    this.waiter?.({ done: true, value: undefined });
    this.waiter = undefined;
    return Promise.resolve();
  }

  public [Symbol.asyncIterator](): AsyncIterator<MarketStreamEvent> {
    return {
      next: () => {
        const event = this.events.shift();
        if (event !== undefined) return Promise.resolve({ done: false, value: event });
        if (this.closed) return Promise.resolve({ done: true, value: undefined });
        return new Promise((resolve) => {
          this.waiter = resolve;
        });
      },
    };
  }
}

class SkippedForecaster implements SessionForecaster {
  public forecast(
    _snapshot: ForecastSnapshot,
    _signal: AbortSignal,
  ): Promise<ForecastBatchResult> {
    return Promise.resolve({ status: "skipped", reason: "no_forecastable_markets" });
  }
}

class CapturingForecaster implements SessionForecaster {
  public readonly snapshots: ForecastSnapshot[] = [];

  public forecast(
    snapshot: ForecastSnapshot,
    _signal: AbortSignal,
  ): Promise<ForecastBatchResult> {
    this.snapshots.push(snapshot);
    return Promise.resolve({ status: "skipped", reason: "no_forecastable_markets" });
  }
}

class ControlledForecaster implements SessionForecaster {
  public calls = 0;
  private snapshot: ForecastSnapshot | undefined;
  private resolve: ((result: ForecastBatchResult) => void) | undefined;

  public forecast(
    snapshot: ForecastSnapshot,
    _signal: AbortSignal,
  ): Promise<ForecastBatchResult> {
    this.calls += 1;
    if (this.calls > 1) {
      return Promise.resolve({ status: "skipped", reason: "no_forecastable_markets" });
    }
    this.snapshot = snapshot;
    return new Promise((resolve) => {
      this.resolve = resolve;
    });
  }

  public complete(): void {
    const snapshot = this.snapshot;
    if (snapshot === undefined || this.resolve === undefined) {
      throw new Error("forecast is not in flight");
    }
    this.resolve({
      status: "completed",
      requestedAtMs: snapshot.snapshotAtMs,
      completedAtMs: Date.now(),
      model: "test-model",
      request: { state: {}, questions: {}, model: "test-model" },
      answers: [{
        marketId: "market-1",
        probability: 0.99,
        model: "test-model",
        snapshotAtMs: snapshot.snapshotAtMs,
        latencyMs: 10,
      }],
    });
  }
}

const silentLogger: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

async function flushTasks(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}
