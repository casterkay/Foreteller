import type { OrderBook } from "@polymarket/client";
import { describe, expect, it, vi } from "vitest";

import type { Logger } from "../../src/core/log.js";
import type { ForecastBatchResult, ForecastSnapshot } from "../../src/forecast/index.js";
import type {
  MarketSubscriptionClient,
  MarketSubscriptionHandle,
} from "../../src/market/subscription.js";
import { PanelRuntime, PanelState } from "../../src/panel/index.js";
import type {
  AudioSource,
  StreamingTranscriber,
  TranscriptEvent,
} from "../../src/transcript/index.js";

describe("PanelRuntime", () => {
  it("forecasts every custom term from the latest final transcript", async () => {
    const state = new PanelState();
    const transcriber = new ControlledTranscriber();
    const forecaster = new RecordingForecaster();
    const runtime = new PanelRuntime({
      state,
      transcriber,
      forecaster,
      proposer: { propose: () => Promise.reject(new Error("not used")) },
      videoProbe: {
        inspect: async () => ({
          videoId: "video-1",
          title: "Live speech",
          channelId: "channel-1",
          liveStatus: "is_live",
        }),
      },
      subscriberClient: unusedSubscriptionClient,
      logger: silentLogger,
      forecastFallbackMs: 100_000,
      createAudioSource: () => unusedAudioSource,
    });

    await runtime.configure({
      youtubeUrl: "https://www.youtube.com/watch?v=video-1",
      eventUrl: "",
      customTitle: "Live speech",
      customTerms: ["alpha", "beta"],
      speaker: "Ada",
    });
    transcriber.emit(transcript("opening statement", 1_000));
    await vi.waitFor(() => expect(forecaster.snapshots).toHaveLength(1));
    transcriber.emit(transcript("latest context", 2_000));
    await vi.waitFor(() => expect(forecaster.snapshots).toHaveLength(2));

    const latest = forecaster.snapshots[1];
    expect(latest?.recentTranscript).toBe("opening statement latest context");
    expect(latest?.transcriptCutoffMs).toBe(2_000);
    expect(latest?.markets.map((market) => market.term.label)).toEqual(["alpha", "beta"]);
    expect(latest?.matchedMarketIds.size).toBe(0);
    expect(state.snapshot().youtubeUrl).toBe("https://www.youtube.com/watch?v=video-1");
    expect(state.snapshot().markets.map((market) => market.jevProbability)).toEqual([0.7, 0.7]);

    await runtime.stop();
  });

  it("does not replace the active session after configuration is cancelled", async () => {
    const state = new PanelState();
    const transcriber = new ControlledTranscriber();
    let resolveInspection: (() => void) | undefined;
    let inspectionCount = 0;
    const runtime = new PanelRuntime({
      state,
      transcriber,
      forecaster: new RecordingForecaster(),
      proposer: { propose: () => Promise.reject(new Error("not used")) },
      videoProbe: {
        inspect: async () => {
          inspectionCount += 1;
          if (inspectionCount > 1) {
            await new Promise<void>((resolve) => { resolveInspection = resolve; });
          }
          return {
            videoId: "video-1",
            title: "Live speech",
            channelId: "channel-1",
            liveStatus: "is_live" as const,
          };
        },
      },
      subscriberClient: unusedSubscriptionClient,
      logger: silentLogger,
      forecastFallbackMs: 100_000,
      createAudioSource: () => unusedAudioSource,
    });
    const configuration = {
      youtubeUrl: "https://www.youtube.com/watch?v=video-1",
      eventUrl: "",
      customTitle: "Live speech",
      customTerms: ["alpha"],
      speaker: "Ada",
    } as const;
    await runtime.configure(configuration);
    const controller = new AbortController();
    const replacement = runtime.configure(
      { ...configuration, customTitle: "Replacement" },
      controller.signal,
    );
    await vi.waitFor(() => expect(resolveInspection).toBeDefined());
    controller.abort(new Error("client disconnected"));
    resolveInspection?.();

    await expect(replacement).rejects.toThrow(/client disconnected/);
    expect(state.snapshot().title).toBe("Live speech");
    expect(state.snapshot().status).toBe("live");
    await runtime.stop();
  });

  it("ends an event session at the Polymarket horizon", async () => {
    const now = Date.now();
    const state = new PanelState();
    const transcriber = new ControlledTranscriber();
    const subscriptionClient = new PassiveSubscriptionClient();
    const runtime = new PanelRuntime({
      state,
      transcriber,
      forecaster: new RecordingForecaster(),
      proposer: {
        propose: async () => ({
          eventId: "event-1",
          eventTitle: "Live speech",
          expectedStartMs: now - 1_000,
          expectedEndMs: now + 50,
          rulesHash: "rules",
          markets: [eventMarket(now + 50)],
        }),
      },
      videoProbe: {
        inspect: async () => ({
          videoId: "video-1",
          title: "Live speech",
          channelId: "channel-1",
          liveStatus: "is_live",
        }),
      },
      subscriberClient: subscriptionClient,
      logger: silentLogger,
      forecastFallbackMs: 100_000,
      createAudioSource: () => unusedAudioSource,
    });

    await runtime.configure({
      youtubeUrl: "https://www.youtube.com/watch?v=video-1",
      eventUrl: "https://polymarket.com/event/live-speech",
      customTitle: "",
      customTerms: [],
      speaker: "Ada",
    });

    await vi.waitFor(() => expect(state.snapshot().status).toBe("ended"));
    await vi.waitFor(() => expect(subscriptionClient.closed).toBe(true));
    await runtime.stop();
  });

  it("removes an event market after observing its qualifying mention", async () => {
    const now = Date.now();
    const state = new PanelState();
    const transcriber = new ControlledTranscriber();
    const runtime = new PanelRuntime({
      state,
      transcriber,
      forecaster: new RecordingForecaster(),
      proposer: {
        propose: async () => ({
          eventId: "event-1",
          eventTitle: "Live speech",
          expectedStartMs: now - 1_000,
          expectedEndMs: now + 60_000,
          rulesHash: "rules",
          markets: [eventMarket(now + 60_000)],
        }),
      },
      videoProbe: { inspect: async () => ({
        videoId: "video-1",
        title: "Live speech",
        channelId: "channel-1",
        liveStatus: "is_live",
      }) },
      subscriberClient: new PassiveSubscriptionClient(),
      logger: silentLogger,
      forecastFallbackMs: 100_000,
      createAudioSource: () => unusedAudioSource,
    });
    await runtime.configure({
      youtubeUrl: "https://www.youtube.com/watch?v=video-1",
      eventUrl: "https://polymarket.com/event/live-speech",
      customTitle: "",
      customTerms: [],
      speaker: "Ada",
    });
    expect(state.snapshot().comparisonCoverage).toBe("partial_event");

    transcriber.emit(transcript("alpha", now + 200));

    await vi.waitFor(() => expect(state.snapshot().markets).toHaveLength(0));
    await runtime.stop();
  });

  it("stops a session whose market subscription never established", async () => {
    const now = Date.now();
    const state = new PanelState();
    const runtime = new PanelRuntime({
      state,
      transcriber: new ControlledTranscriber(),
      forecaster: new RecordingForecaster(),
      proposer: {
        propose: async () => ({
          eventId: "event-1",
          eventTitle: "Live speech",
          expectedStartMs: now - 1_000,
          expectedEndMs: now + 60_000,
          rulesHash: "rules",
          markets: [eventMarket(now + 60_000)],
        }),
      },
      videoProbe: { inspect: async () => ({
        videoId: "video-1",
        title: "Live speech",
        channelId: "channel-1",
        liveStatus: "is_live",
      }) },
      subscriberClient: {
        fetchOrderBook: () => Promise.reject(new Error("not reached")) as Promise<OrderBook>,
        subscribe: () => new Promise<MarketSubscriptionHandle>(() => undefined),
      },
      logger: silentLogger,
      forecastFallbackMs: 100_000,
      marketSubscriptionTimeoutMs: 20,
      createAudioSource: () => unusedAudioSource,
    });
    await runtime.configure({
      youtubeUrl: "https://www.youtube.com/watch?v=video-1",
      eventUrl: "https://polymarket.com/event/live-speech",
      customTitle: "",
      customTerms: [],
      speaker: "Ada",
    });

    await runtime.stop();

    expect(state.snapshot().status).toBe("idle");
  });

  it("resets state when cancellation lands while the old session is stopping", async () => {
    const state = new PanelState();
    const transcriber = new BlockingStopTranscriber();
    const runtime = new PanelRuntime({
      state,
      transcriber,
      forecaster: new RecordingForecaster(),
      proposer: { propose: () => Promise.reject(new Error("not used")) },
      videoProbe: { inspect: async () => ({
        videoId: "video-1",
        title: "Live speech",
        channelId: "channel-1",
        liveStatus: "is_live",
      }) },
      subscriberClient: unusedSubscriptionClient,
      logger: silentLogger,
      forecastFallbackMs: 100_000,
      createAudioSource: () => unusedAudioSource,
    });
    const configuration = {
      youtubeUrl: "https://www.youtube.com/watch?v=video-1",
      eventUrl: "",
      customTitle: "First",
      customTerms: ["alpha"],
      speaker: "Ada",
    } as const;
    await runtime.configure(configuration);
    const controller = new AbortController();
    const replacement = runtime.configure(
      { ...configuration, customTitle: "Replacement" },
      controller.signal,
    );
    await vi.waitFor(() => expect(transcriber.aborted).toBe(true));
    controller.abort(new Error("client disconnected"));
    transcriber.release();

    await expect(replacement).rejects.toThrow(/client disconnected/);
    expect(state.snapshot().status).toBe("idle");
  });
});

class ControlledTranscriber implements StreamingTranscriber {
  private callback: ((event: TranscriptEvent) => void) | undefined;

  public run(
    _source: AudioSource,
    onTranscript: (event: TranscriptEvent) => void,
    signal: AbortSignal,
  ): Promise<void> {
    this.callback = onTranscript;
    return new Promise((resolve) => {
      signal.addEventListener("abort", () => resolve(), { once: true });
    });
  }

  public emit(event: TranscriptEvent): void {
    if (this.callback === undefined) throw new Error("Transcriber has not started");
    this.callback(event);
  }
}

class RecordingForecaster {
  public readonly snapshots: ForecastSnapshot[] = [];

  public forecast(snapshot: ForecastSnapshot, _signal: AbortSignal): Promise<ForecastBatchResult> {
    this.snapshots.push(snapshot);
    const completedAtMs = Date.now();
    return Promise.resolve(Object.freeze({
      status: "completed" as const,
      requestedAtMs: completedAtMs - 5,
      completedAtMs,
      model: "jev-test",
      request: Object.freeze({ state: "", questions: Object.freeze({}), model: "jev-test" }),
      answers: Object.freeze(snapshot.markets.map((market) => Object.freeze({
        marketId: market.marketId,
        probability: 0.7,
        model: "jev-test",
        snapshotAtMs: snapshot.snapshotAtMs,
        latencyMs: 5,
      }))),
    }));
  }
}

class BlockingStopTranscriber implements StreamingTranscriber {
  public aborted = false;
  private resolveRun: (() => void) | undefined;

  public run(
    _source: AudioSource,
    _onTranscript: (event: TranscriptEvent) => void,
    signal: AbortSignal,
  ): Promise<void> {
    signal.addEventListener("abort", () => { this.aborted = true; }, { once: true });
    return new Promise((resolve) => { this.resolveRun = resolve; });
  }

  public release(): void {
    this.resolveRun?.();
  }
}

function transcript(text: string, sourceEndMs: number): TranscriptEvent {
  return Object.freeze({
    segment: Object.freeze({
      id: text,
      text,
      words: Object.freeze([Object.freeze({
        text,
        startMs: sourceEndMs - 100,
        endMs: sourceEndMs,
        confidence: 0.99,
        speaker: 0,
      })]),
      sourceStartMs: sourceEndMs - 100,
      sourceEndMs,
      receivedAtMs: Date.now(),
      isFinal: true,
    }),
    observedAgeMs: 0,
    observedAgeBasis: "pipeline_clock" as const,
  });
}

const unusedAudioSource: AudioSource = Object.freeze({
  run: () => Promise.reject(new Error("not used")),
});

const unusedSubscriptionClient: MarketSubscriptionClient = Object.freeze({
  fetchOrderBook: () => Promise.reject(new Error("not used")) as Promise<OrderBook>,
  subscribe: () => Promise.reject(new Error("not used")) as Promise<MarketSubscriptionHandle>,
});

class PassiveSubscriptionClient implements MarketSubscriptionClient {
  public closed = false;
  private resolveNext: (() => void) | undefined;

  public fetchOrderBook(): Promise<OrderBook> {
    return Promise.resolve({
      assetId: "yes-token",
      bids: [{ price: "0.49", size: "10" }],
      asks: [{ price: "0.51", size: "10" }],
      tickSize: "0.01",
      timestamp: Date.now(),
    } as unknown as OrderBook);
  }

  public subscribe(): Promise<MarketSubscriptionHandle> {
    return Promise.resolve({
      [Symbol.asyncIterator]: () => ({
        next: async () => {
          await new Promise<void>((resolve) => { this.resolveNext = resolve; });
          return { done: true, value: undefined };
        },
      }),
      close: () => {
        this.closed = true;
        this.resolveNext?.();
        return Promise.resolve();
      },
    });
  }
}

function eventMarket(expectedEndMs: number) {
  return Object.freeze({
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
    term: Object.freeze({
      marketId: "market-1",
      label: "alpha",
      acceptedForms: Object.freeze(["alpha"]),
      excludedForms: Object.freeze([]),
      speakerScope: "primary" as const,
      windowStartMs: expectedEndMs - 60_000,
      windowEndMs: expectedEndMs,
    }),
  });
}

const silentLogger: Logger = Object.freeze({
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
});
