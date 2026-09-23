import { randomUUID } from "node:crypto";
import { join } from "node:path";

import type { Limits } from "../config.js";
import type { Logger } from "../core/log.js";
import type {
  BookSnapshot,
  ForecastAnswer,
  MarketDefinition,
  MentionHit,
  OrderIntent,
  SessionBinding,
  SessionStatus,
} from "../domain/types.js";
import { ReconciliationRequiredError, type SerializedExecutor } from "../execution/index.js";
import type { ForecastBatchResult, ForecastSnapshot } from "../forecast/index.js";
import { MarketBookSubscriber, type MarketSubscriptionClient } from "../market/subscription.js";
import type { BookState } from "../market/types.js";
import type { YouTubeMetadata } from "../media/youtube.js";
import type { SqliteStore } from "../storage/index.js";
import {
  decideForecastOrder,
  decideSniperOrder,
  type ForecastDecisionInput,
  type SniperDecisionInput,
  type StrategyDecision,
} from "../strategy/index.js";
import {
  TranscriptMatcher,
  YoutubeAudioSource,
  type StreamingTranscriber,
  type TranscriptEvent,
} from "../transcript/index.js";

export interface BindingVerifier {
  verify(binding: SessionBinding): Promise<boolean>;
}

export interface SessionVideoProbe {
  inspect(videoUrl: string): Promise<YouTubeMetadata>;
}

export interface SessionForecaster {
  forecast(snapshot: ForecastSnapshot, signal: AbortSignal): Promise<ForecastBatchResult>;
}

export interface LiveSessionRuntimeOptions {
  readonly store: SqliteStore;
  readonly subscriberClient: MarketSubscriptionClient;
  readonly videoProbe: SessionVideoProbe;
  readonly transcriber: StreamingTranscriber;
  readonly forecaster: SessionForecaster;
  readonly executor: SerializedExecutor;
  readonly verifier: BindingVerifier;
  readonly limits: Limits;
  readonly logger: Logger;
  readonly liveTrading: boolean;
  readonly sessionDataDirectory: string;
  readonly pollIntervalMs?: number;
  readonly forecastFallbackMs?: number;
  readonly rulesCheckMs?: number;
  readonly reconcileIntervalMs?: number;
}

interface ActiveRuntime {
  readonly binding: SessionBinding;
  readonly controller: AbortController;
  task: Promise<void>;
  status: SessionStatus;
}

interface AttemptState {
  attempts: number;
  lastAttemptAtMs: number | undefined;
}

export interface AudioTimingEvidence {
  readonly observedAgeMs: number;
  readonly observedAgeBasis: TranscriptEvent["observedAgeBasis"];
  readonly observedAtMs: number;
}

export class LiveSessionRuntime {
  private active: ActiveRuntime | undefined;

  public constructor(private readonly options: LiveSessionRuntimeOptions) {}

  public async start(binding: SessionBinding): Promise<void> {
    if (this.active !== undefined) {
      if (!isTerminal(this.active.status)) {
        throw new Error("another session runtime is active");
      }
      await this.active.task;
    }
    await this.options.executor.reconcileStartup();
    this.options.executor.resume();
    const controller = new AbortController();
    const active: ActiveRuntime = {
      binding,
      controller,
      status: "waiting",
      task: Promise.resolve(),
    };
    active.task = this.run(active).catch((error: unknown) => {
      if (controller.signal.aborted) return;
      this.options.executor.halt();
      active.status = "halted";
      this.options.store.recordSessionStatus(binding.sessionId, "halted", Date.now());
      this.options.logger.error("Session runtime halted", {
        sessionId: binding.sessionId,
        error: errorMessage(error),
      });
    });
    this.active = active;
  }

  public async halt(binding: SessionBinding): Promise<void> {
    const active = this.active;
    if (active === undefined || active.binding.sessionId !== binding.sessionId) return;
    this.options.executor.halt();
    active.status = "halted";
    active.controller.abort(new Error("operator halt"));
    await active.task;
  }

  public async shutdown(): Promise<void> {
    const active = this.active;
    if (active === undefined) return;
    if (isTerminal(active.status)) {
      await active.task;
      return;
    }
    this.options.executor.halt();
    active.status = "halted";
    this.options.store.recordSessionStatus(active.binding.sessionId, "halted", Date.now());
    active.controller.abort(new Error("service shutdown"));
    await active.task;
  }

  public status(binding: SessionBinding): Promise<Exclude<SessionStatus, "draft">> {
    const active = this.active;
    if (active === undefined || active.binding.sessionId !== binding.sessionId) {
      return Promise.resolve("ended");
    }
    return Promise.resolve(active.status === "draft" ? "waiting" : active.status);
  }

  private async run(active: ActiveRuntime): Promise<void> {
    const { binding, controller } = active;
    const signal = controller.signal;
    const live = await this.waitForLive(binding, signal);
    if (signal.aborted) return;
    if (!live) {
      active.status = "ended";
      this.options.store.recordSessionStatus(binding.sessionId, "ended", Date.now());
      return;
    }

    active.status = "live";
    this.options.store.recordSessionStatus(binding.sessionId, "live", Date.now());

    const books = new Map<string, BookSnapshot>();
    const tokenMarkets = new Map<string, MarketDefinition>();
    const tickSizes = new Map<string, number>();
    for (const market of binding.markets) {
      tokenMarkets.set(market.yesTokenId, market);
      tokenMarkets.set(market.noTokenId, market);
      tickSizes.set(market.yesTokenId, market.tickSize);
      tickSizes.set(market.noTokenId, market.tickSize);
    }
    const matcher = new TranscriptMatcher(
      binding.markets.map((market) => market.term),
      {
        minimumWordConfidence: this.options.limits.minimumWordConfidence,
        primarySpeaker: binding.primarySpeaker ?? 0,
      },
    );
    const attempts = new Map<string, AttemptState>();
    const recentTranscript: string[] = [];
    let latestTranscriptCutoffMs = binding.expectedStartMs;
    const lastTopAsk = new Map<string, number | undefined>();
    const lastBookJournalAt = new Map<string, number>();
    let latestTiming: AudioTimingEvidence | undefined;
    let eventTail = Promise.resolve();
    let forecastTask: Promise<void> | undefined;
    let forecastQueued = false;

    const enqueue = (operation: () => Promise<void>): void => {
      eventTail = eventTail.then(operation).catch((error: unknown) => {
        if (!signal.aborted) {
          active.status = "halted";
          this.options.executor.halt();
          this.options.store.recordSessionStatus(binding.sessionId, "halted", Date.now());
          controller.abort(error);
        }
        this.options.logger.error("Session event failed", {
          sessionId: binding.sessionId,
          error: errorMessage(error),
        });
      });
    };

    const runForecast = async (): Promise<void> => {
      if (signal.aborted || latestTiming === undefined) return;
      const now = Date.now();
      let result;
      try {
        result = await this.options.forecaster.forecast(
          {
            snapshotAtMs: now,
            eventTitle: binding.eventTitle,
            eventRules: binding.markets.map((market) => market.description).join("\n"),
            speaker: binding.speaker,
            eventPhase: phase(binding, now),
            elapsedMs: Math.max(0, now - binding.expectedStartMs),
            estimatedRemainingMs: Math.max(0, binding.expectedEndMs - now),
            transcriptCutoffMs: latestTranscriptCutoffMs,
            recentTranscript: recentTranscript.join(" "),
            earlierSummary: "",
            markets: binding.markets,
            matchedMarketIds: matcher.matchedMarketIds,
          },
          signal,
        );
      } catch (error) {
        if (!signal.aborted) {
          this.options.logger.warn("Jev forecast unavailable", {
            sessionId: binding.sessionId,
            error: errorMessage(error),
          });
        }
        return;
      }
      if (result.status !== "completed" || signal.aborted) return;
      enqueue(async () => {
        if (signal.aborted || latestTiming === undefined) return;
        this.options.store.recordForecastBatch(binding.sessionId, {
          snapshotAtMs: result.answers[0]?.snapshotAtMs ?? result.requestedAtMs,
          requestedAtMs: result.requestedAtMs,
          completedAtMs: result.completedAtMs,
          model: result.model,
          requestJson: JSON.stringify(result.request),
        });
        for (const forecast of result.answers) {
          this.options.store.recordForecast(binding.sessionId, forecast, result.completedAtMs);
          await this.handleForecast(
            binding,
            forecast,
            books,
            matcher,
            attempts,
            latestTiming,
            signal,
          );
        }
      });
    };

    const requestForecast = (): void => {
      if (signal.aborted) return;
      if (forecastTask !== undefined) {
        forecastQueued = true;
        return;
      }
      forecastTask = (async () => {
        do {
          forecastQueued = false;
          await runForecast();
        } while (forecastQueued && !signal.aborted);
      })().finally(() => {
        forecastTask = undefined;
      });
    };

    const subscriber = new MarketBookSubscriber(this.options.subscriberClient, {
      tokenIds: [...tokenMarkets.keys()],
      tickSizes,
      onBook: (state) => {
        const market = tokenMarkets.get(state.tokenId);
        if (market === undefined) return;
        const snapshot = toSnapshot(state);
        books.set(state.tokenId, snapshot);
        const previousJournalAt = lastBookJournalAt.get(state.tokenId) ?? 0;
        if (snapshot.receivedAtMs - previousJournalAt >= 250) {
          this.options.store.recordBookSnapshot(binding.sessionId, market.marketId, snapshot);
          lastBookJournalAt.set(state.tokenId, snapshot.receivedAtMs);
        }
        if (state.tokenId === market.yesTokenId) {
          const topAsk = snapshot.asks[0]?.price;
          if (lastTopAsk.get(state.tokenId) !== topAsk) {
            lastTopAsk.set(state.tokenId, topAsk);
            requestForecast();
          }
        }
      },
      onError: (error) => this.options.logger.warn("Market stream reconnecting", {
        sessionId: binding.sessionId,
        error: error.message,
      }),
    });

    const forecastTimer = setInterval(
      requestForecast,
      this.options.forecastFallbackMs ?? 30_000,
    );
    forecastTimer.unref();
    const rulesTimer = setInterval(() => {
      enqueue(async () => {
        if (!(await this.options.verifier.verify(binding))) {
          active.status = "halted";
          this.options.executor.halt();
          this.options.store.recordSessionStatus(binding.sessionId, "halted", Date.now());
          controller.abort(new Error("event rules changed"));
          throw new Error("event rules changed after confirmation");
        }
      });
    }, this.options.rulesCheckMs ?? 30_000);
    rulesTimer.unref();
    const reconcileTimer = setInterval(() => {
      enqueue(async () => {
        try {
          await this.options.executor.reconcile();
          if (!signal.aborted) this.options.executor.resume();
        } catch (error) {
          if (error instanceof ReconciliationRequiredError) {
            this.options.logger.warn("Orders still require reconciliation", {
              sessionId: binding.sessionId,
              unresolvedCount: error.unresolvedCount,
            });
            return;
          }
          throw error;
        }
      });
    }, this.options.reconcileIntervalMs ?? 5_000);
    reconcileTimer.unref();
    const endTimer = setInterval(() => {
      if (Date.now() < binding.expectedEndMs || signal.aborted) return;
      active.status = "ended";
      this.options.executor.halt();
      this.options.store.recordSessionStatus(binding.sessionId, "ended", Date.now());
      controller.abort(new Error("qualifying event window ended"));
    }, 1_000);
    endTimer.unref();

    subscriber.start();
    try {
      const source = new YoutubeAudioSource({
        videoUrl: binding.videoUrl,
        archivePath: join(
          this.options.sessionDataDirectory,
          binding.sessionId,
          `audio-${String(Date.now())}.flac`,
        ),
      });
      await this.options.transcriber.run(
        source,
        (event) => {
          enqueue(async () => {
            latestTiming = {
              observedAgeMs: event.observedAgeMs,
              observedAgeBasis: event.observedAgeBasis,
              observedAtMs: event.segment.receivedAtMs,
            };
            const update = matcher.ingest(event.segment);
            if (!event.segment.isFinal) return;
            if (!update.addedFinal) return;
            if (!this.options.store.recordTranscript(binding.sessionId, event.segment)) return;
            latestTranscriptCutoffMs = event.segment.sourceEndMs;
            recentTranscript.push(event.segment.text);
            while (recentTranscript.join(" ").length > 8_000) recentTranscript.shift();
            for (const hit of update.hits) {
              await this.handleSniper(binding, hit, books, attempts, latestTiming, signal);
            }
            requestForecast();
          });
        },
        signal,
      );
      await eventTail;
      if (!signal.aborted) {
        this.options.executor.halt();
        const status = Date.now() >= binding.expectedEndMs ? "ended" : "halted";
        active.status = status;
        this.options.store.recordSessionStatus(binding.sessionId, status, Date.now());
        controller.abort(new Error(
          status === "ended"
            ? "qualifying event window ended"
            : "transcription source ended before the qualifying event window",
        ));
      }
    } finally {
      clearInterval(forecastTimer);
      clearInterval(rulesTimer);
      clearInterval(reconcileTimer);
      clearInterval(endTimer);
      await subscriber.stop();
      await forecastTask;
      await eventTail;
    }
  }

  private async waitForLive(binding: SessionBinding, signal: AbortSignal): Promise<boolean> {
    while (!signal.aborted) {
      if (Date.now() > binding.expectedEndMs) return false;
      const video = await this.options.videoProbe.inspect(binding.videoUrl);
      if (video.videoId !== binding.videoId || video.channelId !== binding.channelId) {
        throw new Error("confirmed video binding changed");
      }
      if (video.liveStatus === "is_live") return true;
      if (video.liveStatus === "was_live" || video.liveStatus === "post_live") return false;
      await abortableDelay(this.options.pollIntervalMs ?? 15_000, signal);
    }
    return false;
  }

  private async handleSniper(
    binding: SessionBinding,
    mention: MentionHit,
    books: ReadonlyMap<string, BookSnapshot>,
    attempts: Map<string, AttemptState>,
    timing: AudioTimingEvidence,
    signal: AbortSignal,
  ): Promise<void> {
    const market = binding.markets.find((candidate) => candidate.marketId === mention.marketId);
    if (market === undefined) return;
    while (!signal.aborted) {
      const state = attemptState(attempts, "sniper", market.marketId);
      const book = books.get(market.yesTokenId) ?? unavailableBook(market, Date.now());
      const remainingAllowance = Math.max(
        0,
        this.options.limits.sniperMarketAllowance -
          this.options.store.exposure({ marketId: market.marketId, strategy: "sniper" }),
      );
      const decisionInput: SniperDecisionInput = {
        mention,
        market,
        book,
        nowMs: Date.now(),
        remainingAllowance,
        attempts: state.attempts,
        lastAttemptAtMs: state.lastAttemptAtMs,
        limits: this.options.limits,
      };
      const decision = decideSniperOrder(decisionInput);
      const result = await this.persistAndMaybeExecute(
        binding,
        market,
        book,
        decision,
        decisionInput,
        timing,
        signal,
      );
      if (!decision.accepted || result !== "partially_filled" || !this.options.liveTrading) return;
      state.attempts += 1;
      state.lastAttemptAtMs = Date.now();
      await abortableDelay(this.options.limits.sniperCooldownMs, signal);
    }
  }

  private async handleForecast(
    binding: SessionBinding,
    forecast: ForecastAnswer,
    books: ReadonlyMap<string, BookSnapshot>,
    matcher: TranscriptMatcher,
    attempts: Map<string, AttemptState>,
    timing: AudioTimingEvidence,
    signal: AbortSignal,
  ): Promise<void> {
    const market = binding.markets.find((candidate) => candidate.marketId === forecast.marketId);
    if (market === undefined) return;
    const state = attemptState(attempts, "forecast", market.marketId);
    const book = books.get(market.yesTokenId) ?? unavailableBook(market, Date.now());
    const remainingAllowance = Math.max(
      0,
      this.options.limits.forecastMarketAllowance -
        this.options.store.exposure({ marketId: market.marketId, strategy: "forecast" }),
    );
    const decisionInput: ForecastDecisionInput = {
      forecast,
      market,
      book,
      nowMs: Date.now(),
      remainingAllowance,
      feeSchedule: market.feeExponent === undefined
        ? undefined
        : { rate: market.feeRate, exponent: market.feeExponent },
      marketAlreadyMatched: matcher.matchedMarketIds.has(market.marketId),
      lastAttemptAtMs: state.lastAttemptAtMs,
      limits: this.options.limits,
    };
    const decision = decideForecastOrder(decisionInput);
    if (decision.accepted) state.lastAttemptAtMs = Date.now();
    await this.persistAndMaybeExecute(
      binding,
      market,
      book,
      decision,
      decisionInput,
      timing,
      signal,
    );
  }

  private async persistAndMaybeExecute(
    binding: SessionBinding,
    market: MarketDefinition,
    book: BookSnapshot,
    decision: StrategyDecision,
    decisionInput: SniperDecisionInput | ForecastDecisionInput,
    timing: AudioTimingEvidence,
    signal: AbortSignal,
  ): Promise<string> {
    if (signal.aborted) return "halted";
    const now = Date.now();
    const currentTiming = effectiveTiming(timing, now);
    const evidenceJson = JSON.stringify({ input: decisionInput, timing: currentTiming, decision });
    const decisionId = randomUUID();
    this.options.store.recordDecision({
      id: decisionId,
      sessionId: binding.sessionId,
      eventId: binding.eventId,
      marketId: market.marketId,
      strategy: decision.strategy,
      accepted: decision.accepted,
      reason: decision.accepted ? "accepted" : decision.reason,
      evidenceJson,
      createdAtMs: now,
    });
    if (!decision.accepted) return "rejected";

    const intent: OrderIntent = Object.freeze({
      id: randomUUID(),
      sessionId: binding.sessionId,
      eventId: binding.eventId,
      marketId: market.marketId,
      tokenId: decision.tokenId,
      strategy: decision.strategy,
      notional: decision.notional,
      maxPrice: decision.maxPrice,
      evidenceJson,
      createdAtMs: now,
    });
    try {
      const result = await this.options.executor.execute({
        intent,
        market,
        book,
        observedAgeMs: currentTiming.observedAgeMs,
        observedAgeBasis: currentTiming.observedAgeBasis,
      });
      return result.status;
    } catch (error) {
      if (error instanceof ReconciliationRequiredError) {
        return "reconciliation_required";
      }
      throw error;
    }
  }
}

export function effectiveTiming(
  timing: AudioTimingEvidence,
  nowMs: number,
): AudioTimingEvidence {
  return Object.freeze({
    ...timing,
    observedAgeMs: timing.observedAgeMs + Math.max(0, nowMs - timing.observedAtMs),
  });
}

function toSnapshot(book: BookState): BookSnapshot {
  return Object.freeze({
    tokenId: book.tokenId,
    bids: book.bids,
    asks: book.asks,
    tickSize: book.tickSize,
    receivedAtMs: book.receivedAtMs,
    synchronized: book.synchronized,
  });
}

function unavailableBook(market: MarketDefinition, nowMs: number): BookSnapshot {
  return Object.freeze({
    tokenId: market.yesTokenId,
    bids: Object.freeze([]),
    asks: Object.freeze([]),
    tickSize: market.tickSize,
    receivedAtMs: nowMs,
    synchronized: false,
  });
}

function attemptState(
  attempts: Map<string, AttemptState>,
  strategy: "sniper" | "forecast",
  marketId: string,
): AttemptState {
  const key = `${strategy}:${marketId}`;
  const existing = attempts.get(key);
  if (existing !== undefined) return existing;
  const state: AttemptState = { attempts: 0, lastAttemptAtMs: undefined };
  attempts.set(key, state);
  return state;
}

function phase(binding: SessionBinding, nowMs: number): string {
  const elapsed = Math.max(0, nowMs - binding.expectedStartMs);
  const duration = binding.expectedEndMs - binding.expectedStartMs;
  const ratio = duration <= 0 ? 1 : elapsed / duration;
  if (ratio < 0.2) return "opening";
  if (ratio < 0.8) return "middle";
  return "closing";
}

function isTerminal(status: SessionStatus): boolean {
  return status === "halted" || status === "ended";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function abortableDelay(delayMs: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const onComplete = (): void => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    };
    const timeout = setTimeout(onComplete, delayMs);
    const onAbort = (): void => {
      clearTimeout(timeout);
      reject(signal.reason);
    };
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
  });
}
