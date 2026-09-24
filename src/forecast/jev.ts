import {
  noul,
  TypeSafeClient,
  type EntryType,
  type NoulQuestion,
} from "@typesafe-ai/sdk";

import type { Clock } from "../core/clock.js";
import { systemClock } from "../core/clock.js";
import type { ForecastAnswer, TermSpec } from "../domain/types.js";

export type ForecastTerm = Pick<
  TermSpec,
  "marketId" | "label" | "acceptedForms" | "excludedForms" | "speakerScope"
> & Partial<Pick<TermSpec, "windowStartMs" | "windowEndMs">>;

export interface ForecastMarket {
  readonly marketId: string;
  readonly question: string;
  readonly description: string;
  readonly term: ForecastTerm;
}

export interface ForecastSnapshot {
  readonly snapshotAtMs: number;
  readonly eventTitle: string;
  readonly eventRules: string;
  readonly speaker: string;
  readonly eventPhase: string;
  readonly elapsedMs: number;
  readonly estimatedRemainingMs: number | null;
  readonly transcriptCutoffMs: number;
  readonly recentTranscript: string;
  readonly earlierSummary: string;
  readonly markets: readonly ForecastMarket[];
  readonly matchedMarketIds: ReadonlySet<string>;
}

export interface JevRequest {
  readonly state: EntryType;
  readonly questions: Readonly<Record<string, NoulQuestion>>;
  readonly model: string;
}

export interface JevRequestOptions {
  readonly signal: AbortSignal;
  readonly timeoutMs: number;
}

export interface JevTransport {
  request(request: JevRequest, options: JevRequestOptions): Promise<unknown>;
}

export interface JevForecasterOptions {
  readonly apiKey?: string;
  readonly model?: string;
  readonly timeoutMs: number;
  readonly maximumForecastAgeMs: number;
  readonly clock?: Clock;
  readonly transport?: JevTransport;
}

export type ForecastSkipReason =
  | "no_unmatched_markets"
  | "event_ended"
  | "stale_snapshot";

export type ForecastBatchResult =
  | {
      readonly status: "completed";
      readonly requestedAtMs: number;
      readonly completedAtMs: number;
      readonly model: string;
      readonly request: JevRequest;
      readonly answers: readonly ForecastAnswer[];
    }
  | {
      readonly status: "discarded";
      readonly reason: "stale_response";
      readonly requestedAtMs: number;
      readonly completedAtMs: number;
    }
  | {
      readonly status: "skipped";
      readonly reason: ForecastSkipReason;
    };

export class InvalidJevResponseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidJevResponseError";
  }
}

export class JevTimeoutError extends Error {
  constructor(timeoutMs: number, options?: ErrorOptions) {
    super(`Jev request timed out after ${timeoutMs}ms`, options);
    this.name = "JevTimeoutError";
  }
}

class TypeSafeJevTransport implements JevTransport {
  readonly #client: TypeSafeClient;

  constructor(apiKey: string | undefined) {
    this.#client = new TypeSafeClient(
      apiKey === undefined ? undefined : { apiKey },
    );
  }

  request(request: JevRequest, options: JevRequestOptions): Promise<unknown> {
    return this.#client.systemOne(
      {
        state: request.state,
        questions: request.questions,
        model: request.model,
      },
      {
        signal: options.signal,
        timeout: options.timeoutMs,
        retry: { maxRetries: 0 },
      },
    );
  }
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validateAnswers(
  response: unknown,
  questionMarketIds: ReadonlyMap<string, string>,
): { readonly model: string; readonly probabilities: ReadonlyMap<string, number> } {
  if (!isRecord(response) || typeof response.model !== "string" || response.model.length === 0) {
    throw new InvalidJevResponseError("Jev response has no model");
  }
  if (!isRecord(response.answers)) {
    throw new InvalidJevResponseError("Jev response has no answers object");
  }
  if (
    !isRecord(response.usage) ||
    !Number.isInteger(response.usage.input_tokens) ||
    (response.usage.input_tokens as number) < 0 ||
    !Number.isInteger(response.usage.output_tokens) ||
    (response.usage.output_tokens as number) < 0
  ) {
    throw new InvalidJevResponseError("Jev response has invalid usage data");
  }
  const expectedKeys = [...questionMarketIds.keys()].sort();
  const actualKeys = Object.keys(response.answers).sort();
  if (
    expectedKeys.length !== actualKeys.length ||
    expectedKeys.some((key, index) => key !== actualKeys[index])
  ) {
    throw new InvalidJevResponseError("Jev response answer keys do not match the request");
  }

  const probabilities = new Map<string, number>();
  for (const [questionId, marketId] of questionMarketIds) {
    const answer = response.answers[questionId];
    if (
      !isRecord(answer) ||
      answer.type !== "noul" ||
      typeof answer.noul !== "number" ||
      !Number.isFinite(answer.noul) ||
      answer.noul < 0 ||
      answer.noul > 1
    ) {
      throw new InvalidJevResponseError(
        `Jev response contains an invalid Noul answer for ${questionId}`,
      );
    }
    probabilities.set(marketId, answer.noul);
  }
  return Object.freeze({ model: response.model, probabilities });
}

function createRequest(
  snapshot: ForecastSnapshot,
  model: string,
): {
  readonly request: JevRequest;
  readonly questionMarketIds: ReadonlyMap<string, string>;
} {
  const state = Object.freeze({
    event: Object.freeze({
      title: snapshot.eventTitle,
      rules: snapshot.eventRules,
      qualifying_speaker: snapshot.speaker,
      phase: snapshot.eventPhase,
      elapsed_ms: snapshot.elapsedMs,
      estimated_remaining_ms: snapshot.estimatedRemainingMs,
    }),
    transcript: Object.freeze({
      cutoff_ms: snapshot.transcriptCutoffMs,
      recent_verbatim: snapshot.recentTranscript,
      earlier_summary: snapshot.earlierSummary,
    }),
  });
  const questions: Record<string, NoulQuestion> = {};
  const questionMarketIds = new Map<string, string>();
  let index = 0;
  for (const market of snapshot.markets) {
    if (snapshot.matchedMarketIds.has(market.marketId)) continue;
    const questionId = `market_${String(index)}`;
    index += 1;
    questionMarketIds.set(questionId, market.marketId);
    questions[questionId] = noul(
      {
        question:
          "Will the qualifying speaker mention this term after the transcript cutoff and before the qualifying event ends?",
        market_question: market.question,
        market_description: market.description,
        term_label: market.term.label,
        accepted_forms: [...market.term.acceptedForms],
        excluded_forms: [...market.term.excludedForms],
        speaker_scope: market.term.speakerScope,
        ...(market.term.windowStartMs === undefined || market.term.windowEndMs === undefined
          ? {}
          : {
              qualifying_window: {
                start_ms: market.term.windowStartMs,
                end_ms: market.term.windowEndMs,
              },
            }),
      },
      {
        true: "The term will be mentioned within the qualifying rules and remaining window.",
        false:
          "The term will not be mentioned within the qualifying rules and remaining window.",
      },
    );
  }
  return Object.freeze({
    request: Object.freeze({
      state,
      questions: Object.freeze(questions),
      model,
    }),
    questionMarketIds,
  });
}

async function requestWithTimeout(
  transport: JevTransport,
  request: JevRequest,
  parentSignal: AbortSignal,
  timeoutMs: number,
): Promise<unknown> {
  const timeoutController = new AbortController();
  const signal = AbortSignal.any([parentSignal, timeoutController.signal]);
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let removeAbortListener = (): void => undefined;
  const abortPromise = new Promise<never>((_resolve, reject) => {
    const onAbort = (): void => reject(signal.reason);
    removeAbortListener = () => signal.removeEventListener("abort", onAbort);
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
  });
  const timeoutPromise = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(() => {
      const error = new JevTimeoutError(timeoutMs);
      timeoutController.abort(error);
      reject(error);
    }, timeoutMs);
  });
  try {
    return await Promise.race([
      transport.request(request, { signal, timeoutMs }),
      timeoutPromise,
      abortPromise,
    ]);
  } finally {
    removeAbortListener();
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

export class JevForecaster {
  readonly #model: string;
  readonly #timeoutMs: number;
  readonly #maximumForecastAgeMs: number;
  readonly #clock: Clock;
  readonly #transport: JevTransport;

  constructor(options: JevForecasterOptions) {
    if (options.timeoutMs <= 0) throw new RangeError("timeoutMs must be positive");
    if (options.maximumForecastAgeMs < 0) {
      throw new RangeError("maximumForecastAgeMs cannot be negative");
    }
    this.#model = options.model ?? "jev-latest";
    this.#timeoutMs = options.timeoutMs;
    this.#maximumForecastAgeMs = options.maximumForecastAgeMs;
    this.#clock = options.clock ?? systemClock;
    this.#transport = options.transport ?? new TypeSafeJevTransport(options.apiKey);
  }

  async forecast(
    snapshot: ForecastSnapshot,
    signal: AbortSignal,
  ): Promise<ForecastBatchResult> {
    signal.throwIfAborted();
    const now = this.#clock.now();
    if (now - snapshot.snapshotAtMs > this.#maximumForecastAgeMs) {
      return Object.freeze({ status: "skipped", reason: "stale_snapshot" });
    }
    if (snapshot.estimatedRemainingMs !== null && snapshot.estimatedRemainingMs <= 0) {
      return Object.freeze({ status: "skipped", reason: "event_ended" });
    }

    const { request, questionMarketIds } = createRequest(snapshot, this.#model);
    if (questionMarketIds.size === 0) {
      return Object.freeze({ status: "skipped", reason: "no_unmatched_markets" });
    }

    const requestedAtMs = this.#clock.now();
    const raw = await requestWithTimeout(
      this.#transport,
      request,
      signal,
      this.#timeoutMs,
    );
    const response = validateAnswers(raw, questionMarketIds);
    const completedAtMs = this.#clock.now();
    if (completedAtMs - snapshot.snapshotAtMs > this.#maximumForecastAgeMs) {
      return Object.freeze({
        status: "discarded",
        reason: "stale_response",
        requestedAtMs,
        completedAtMs,
      });
    }
    const latencyMs = Math.max(0, completedAtMs - requestedAtMs);
    const answers = [...response.probabilities].map(([marketId, probability]) =>
      Object.freeze({
        marketId,
        probability,
        model: response.model,
        snapshotAtMs: snapshot.snapshotAtMs,
        latencyMs,
      }),
    );
    return Object.freeze({
      status: "completed",
      requestedAtMs,
      completedAtMs,
      model: response.model,
      request,
      answers: Object.freeze(answers),
    });
  }
}
