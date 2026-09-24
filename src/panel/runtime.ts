import { createHash } from "node:crypto";

import type { Logger } from "../core/log.js";
import type { ForecastMarket, ForecastSnapshot } from "../forecast/index.js";
import type { EventProposal } from "../control/proposal.js";
import type { SessionForecaster, SessionVideoProbe } from "../runtime/index.js";
import {
  MarketBookSubscriber,
  type MarketSubscriptionClient,
} from "../market/subscription.js";
import type { BookState } from "../market/types.js";
import {
  TranscriptMatcher,
  TranscriptWindow,
  YoutubeAudioSource,
  type AudioSource,
  type StreamingTranscriber,
} from "../transcript/index.js";
import { PanelState } from "./state.js";
import type { PanelConfiguration, PanelSnapshot } from "./types.js";

export interface PanelEventProposer {
  propose(eventReference: string): Promise<EventProposal>;
}

export interface PanelRuntimeOptions {
  readonly state: PanelState;
  readonly proposer: PanelEventProposer;
  readonly videoProbe: SessionVideoProbe;
  readonly transcriber: StreamingTranscriber;
  readonly forecaster: SessionForecaster;
  readonly subscriberClient: MarketSubscriptionClient;
  readonly logger: Logger;
  readonly minimumWordConfidence?: number;
  readonly primarySpeaker?: number;
  readonly transcriptMaximumWords?: number;

  /** How long the panel tolerates an unresponsive market stream before abandoning it. */
  readonly marketSubscriptionTimeoutMs?: number;
  readonly createAudioSource?: (videoUrl: string) => AudioSource;
}

interface PreparedPanelSession {
  readonly configuration: PanelConfiguration;
  readonly mode: "event" | "custom";
  readonly title: string;
  readonly markets: readonly ForecastMarket[];
  readonly eventRules: string;
  readonly expectedEndMs: number | null;
  readonly eventProposal: EventProposal | null;
}

interface ActivePanelSession {
  readonly controller: AbortController;
  readonly task: Promise<void>;
  readonly endTimer: ReturnType<typeof setTimeout> | undefined;
}

export class PanelRuntime {
  private active: ActivePanelSession | undefined;
  private operationTail: Promise<void> = Promise.resolve();

  public constructor(private readonly options: PanelRuntimeOptions) {}

  public configure(
    configuration: PanelConfiguration,
    signal: AbortSignal = new AbortController().signal,
  ): Promise<PanelSnapshot> {
    return this.runExclusive(async () => {
      signal.throwIfAborted();
      const prepared = await withCancellation(this.prepare(configuration), signal);
      signal.throwIfAborted();
      await this.stopActive();
      if (signal.aborted) {
        this.options.state.reset();
        signal.throwIfAborted();
      }
      const startedAtMs = Date.now();
      const comparisonCoverage = prepared.mode === "custom"
        ? "jev_only"
        : startedAtMs <= (prepared.eventProposal?.expectedStartMs ?? 0)
          ? "full_event"
          : "partial_event";
      this.options.state.begin({
        mode: prepared.mode,
        title: prepared.title,
        youtubeUrl: configuration.youtubeUrl,
        markets: prepared.markets,
        startedAtMs,
        comparisonCoverage,
      });
      const controller = new AbortController();
      const endTimer = prepared.expectedEndMs === null
        ? undefined
        : setTimeout(() => {
            this.options.state.end();
            controller.abort(new Error("Polymarket event ended"));
          }, Math.max(0, prepared.expectedEndMs - Date.now()));
      endTimer?.unref();
      const task = this.run(prepared, controller.signal, startedAtMs).catch((error: unknown) => {
        if (controller.signal.aborted) return;
        const message = errorMessage(error);
        this.options.state.fail(message);
        this.options.logger.error("Panel session failed", { error: message });
      }).finally(() => {
        if (endTimer !== undefined) clearTimeout(endTimer);
      });
      this.active = Object.freeze({ controller, task, endTimer });
      return this.options.state.snapshot();
    });
  }

  public stop(): Promise<void> {
    return this.runExclusive(async () => {
      await this.stopActive();
      this.options.state.reset();
    });
  }

  private async prepare(configuration: PanelConfiguration): Promise<PreparedPanelSession> {
    validateConfiguration(configuration);
    const [video, eventProposal] = await Promise.all([
      this.options.videoProbe.inspect(configuration.youtubeUrl),
      configuration.eventUrl.length === 0
        ? Promise.resolve(null)
        : this.options.proposer.propose(configuration.eventUrl),
    ]);
    if (video.liveStatus !== "is_live") {
      throw new Error("The YouTube video must currently be live");
    }
    if (eventProposal !== null) {
      return Object.freeze({
        configuration,
        mode: "event",
        title: eventProposal.eventTitle,
        markets: eventProposal.markets,
        eventRules: eventProposal.markets.map((market) => market.description).join("\n"),
        expectedEndMs: eventProposal.expectedEndMs,
        eventProposal,
      });
    }
    const markets = customMarkets(configuration.customTerms);
    return Object.freeze({
      configuration,
      mode: "custom",
      title: configuration.customTitle,
      markets,
      eventRules: "The forecast horizon ends when the current live video ends.",
      expectedEndMs: null,
      eventProposal: null,
    });
  }

  private async run(
    session: PreparedPanelSession,
    signal: AbortSignal,
    startedAtMs: number,
  ): Promise<void> {
    const transcript = new TranscriptWindow(this.options.transcriptMaximumWords ?? 1_000);
    const forecastTasks = new Set<Promise<void>>();
    let revision = 0;
    let appliedRevision = 0;
    const matcher = session.eventProposal === null
      ? undefined
      : new TranscriptMatcher(
          session.eventProposal.markets.map((market) => market.term),
          {
            minimumWordConfidence: this.options.minimumWordConfidence ?? 0.8,
            primarySpeaker: this.options.primarySpeaker ?? 0,
          },
        );

    const runForecast = async (recentTranscript: string, transcriptCutoffMs: number, requestRevision: number): Promise<void> => {
      if (signal.aborted || recentTranscript.length === 0) return;
      const matchedMarketIds = matcher?.matchedMarketIds ?? new Set<string>();
      const activeMarkets = session.markets.filter(
        (market) => !matchedMarketIds.has(market.marketId),
      );
      if (activeMarkets.length === 0) return;
      const now = Date.now();
      const snapshot: ForecastSnapshot = Object.freeze({
        snapshotAtMs: now,
        eventTitle: session.title,
        eventRules: session.eventRules,
        speaker: session.configuration.speaker,
        eventPhase: "live",
        elapsedMs: Math.max(0, now - startedAtMs),
        estimatedRemainingMs: session.expectedEndMs === null
          ? null
          : Math.max(0, session.expectedEndMs - now),
        transcriptCutoffMs,
        recentTranscript,
        earlierSummary: "",
        markets: activeMarkets,
        matchedMarketIds,
      });
      const result = await this.options.forecaster.forecast(snapshot, signal);
      if (result.status === "completed" && !signal.aborted && requestRevision > appliedRevision) {
        appliedRevision = requestRevision;
        this.options.state.recordForecasts(result.answers, result.completedAtMs);
      }
    };

    const requestForecast = (text: string, cutoffMs: number): void => {
      const task = runForecast(text, cutoffMs, ++revision).catch((error: unknown) => {
        if (!signal.aborted) {
          this.options.state.forecastFailed(errorMessage(error));
          this.options.logger.warn("Panel forecast unavailable", { error: errorMessage(error) });
        }
      }).finally(() => forecastTasks.delete(task));
      forecastTasks.add(task);
    };

    const subscriber = this.createSubscriber(session);
    subscriber?.start();
    this.options.state.markLive();

    const audioSource = this.options.createAudioSource?.(
      session.configuration.youtubeUrl,
    ) ?? new YoutubeAudioSource({ videoUrl: session.configuration.youtubeUrl });

    try {
      await this.options.transcriber.run(
        audioSource,
        (event) => {
          if (signal.aborted) return;
          const text = transcript.ingest(event.segment);
          if (text === undefined) return;
          const transcriptUpdate = matcher?.ingest(event.segment);
          for (const hit of transcriptUpdate?.hits ?? []) {
            this.options.state.removeMarket(hit.marketId);
          }
          this.options.state.recordTranscript(event.segment.receivedAtMs);
          requestForecast(text, event.segment.sourceEndMs);
        },
        signal,
      );
      if (!signal.aborted) throw new Error("The live transcription source ended");
    } finally {
      await subscriber?.stop();
      await Promise.all(forecastTasks);
    }
  }

  private createSubscriber(session: PreparedPanelSession): MarketBookSubscriber | undefined {
    const proposal = session.eventProposal;
    if (proposal === null) return undefined;
    const marketsByToken = new Map(
      proposal.markets.map((market) => [market.yesTokenId, market] as const),
    );
    const subscriptionTimeoutMs = this.options.marketSubscriptionTimeoutMs;
    return new MarketBookSubscriber(this.options.subscriberClient, {
      tokenIds: [...marketsByToken.keys()],
      tickSizes: new Map(proposal.markets.map((market) => [market.yesTokenId, market.tickSize])),
      ...(subscriptionTimeoutMs === undefined
        ? {}
        : { startupTimeoutMs: subscriptionTimeoutMs, stopTimeoutMs: subscriptionTimeoutMs }),
      onBook: (book) => {
        const market = marketsByToken.get(book.tokenId);
        if (market === undefined) return;
        this.options.state.recordPrice(
          market.marketId,
          midpoint(book),
          book.receivedAtMs,
        );
      },
      onError: (error) => this.options.logger.warn("Panel market stream reconnecting", {
        error: error.message,
      }),
    });
  }

  private async stopActive(): Promise<void> {
    const active = this.active;
    if (active === undefined) return;
    this.active = undefined;
    if (active.endTimer !== undefined) clearTimeout(active.endTimer);
    active.controller.abort(new Error("panel session replaced"));
    await active.task;
  }

  private runExclusive<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.operationTail.then(operation, operation);
    this.operationTail = next.then(() => undefined, () => undefined);
    return next;
  }
}

function customMarkets(terms: readonly string[]): readonly ForecastMarket[] {
  return Object.freeze(terms.map((term) => {
    const marketId = `custom-${createHash("sha256").update(term).digest("hex").slice(0, 16)}`;
    return Object.freeze({
      marketId,
      question: `Will the primary speaker mention ${term} again before the video ends?`,
      description: `A future mention of ${term} after the latest transcript cutoff.`,
      term: Object.freeze({
        marketId,
        label: term,
        acceptedForms: Object.freeze([term]),
        excludedForms: Object.freeze([]),
        speakerScope: "primary" as const,
      }),
    });
  }));
}

function midpoint(book: BookState): number | null {
  if (!book.synchronized) return null;
  const bestBid = book.bids[0]?.price;
  const bestAsk = book.asks[0]?.price;
  if (bestBid === undefined || bestAsk === undefined) return null;
  return (bestBid + bestAsk) / 2;
}

function validateConfiguration(configuration: PanelConfiguration): void {
  if (!/^https:\/\/(?:www\.)?(?:youtube\.com|youtu\.be)\//u.test(configuration.youtubeUrl)) {
    throw new Error("A valid YouTube URL is required");
  }
  if (configuration.speaker.trim().length === 0) throw new Error("Speaker is required");
  if (configuration.eventUrl.length !== 0) {
    if (!/^https:\/\/(?:www\.)?polymarket\.com\/event\/[^/?#]+(?:[/?#]|$)/u.test(configuration.eventUrl)) {
      throw new Error("A valid Polymarket event URL is required");
    }
    return;
  }
  if (configuration.customTitle.trim().length === 0) {
    throw new Error("Custom title is required without a Polymarket event");
  }
  if (configuration.customTerms.length === 0) {
    throw new Error("At least one custom term is required without a Polymarket event");
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Unexpected panel failure";
}

async function withCancellation<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  let removeAbortListener = (): void => undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    const onAbort = (): void => reject(signal.reason);
    removeAbortListener = () => signal.removeEventListener("abort", onAbort);
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    return await Promise.race([operation, aborted]);
  } finally {
    removeAbortListener();
  }
}
