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
      sessionDataDirectory: "/tmp/foreteller-panel-test",
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
    expect(state.snapshot().markets.map((market) => market.jevProbability)).toEqual([0.7, 0.7]);

    await runtime.stop();
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

function transcript(text: string, sourceEndMs: number): TranscriptEvent {
  return Object.freeze({
    segment: Object.freeze({
      id: text,
      text,
      words: Object.freeze([]),
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

const silentLogger: Logger = Object.freeze({
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
});
