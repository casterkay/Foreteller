import { DeepgramClient } from "@deepgram/sdk";

import type { Clock } from "../core/clock.js";
import { systemClock } from "../core/clock.js";
import type { TranscriptSegment, TranscriptWord } from "../domain/types.js";
import type { AudioChunk, AudioSource } from "./audio.js";

export interface TranscriptEvent {
  readonly segment: TranscriptSegment;
  readonly sourceAgeMs: number | null;
}

export interface StreamingTranscriber {
  run(
    source: AudioSource,
    onTranscript: (event: TranscriptEvent) => void,
    signal: AbortSignal,
  ): Promise<void>;
}

export interface DeepgramConnection {
  on(event: "message", callback: (message: unknown) => void): void;
  on(event: "error", callback: (error: Error) => void): void;
  on(event: "close", callback: () => void): void;
  connect(): DeepgramConnection;
  waitForOpen(): Promise<unknown>;
  sendMedia(data: ArrayBufferView): void;
  sendFinalize(message: { readonly type: "Finalize" }): void;
  sendCloseStream(message: { readonly type: "CloseStream" }): void;
  close(): void;
}

export interface DeepgramConnectionFactory {
  connect(signal: AbortSignal): Promise<DeepgramConnection>;
}

export interface DeepgramStreamingTranscriberOptions {
  readonly apiKey: string;
  readonly model?: string;
  readonly language?: string;
  readonly clock?: Clock;
}

function waitForOpenOrAbort(
  connection: DeepgramConnection,
  signal: AbortSignal,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const cleanup = (): void => signal.removeEventListener("abort", onAbort);
    const onAbort = (): void => {
      cleanup();
      reject(signal.reason);
    };
    if (signal.aborted) {
      onAbort();
      return;
    }
    signal.addEventListener("abort", onAbort, { once: true });
    connection.waitForOpen().then(
      () => {
        cleanup();
        resolve();
      },
      (error: unknown) => {
        cleanup();
        reject(error);
      },
    );
  });
}

function segmentFromResult(
  result: DeepgramResult,
  receivedAtMs: number,
): TranscriptSegment | undefined {
  const alternative = result.channel.alternatives[0];
  if (alternative === undefined || alternative.transcript.trim().length === 0) {
    return undefined;
  }
  const words: readonly TranscriptWord[] = alternative.words.map((word) =>
    Object.freeze({
      text: word.punctuated_word ?? word.word,
      startMs: Math.round(word.start * 1_000),
      endMs: Math.round(word.end * 1_000),
      confidence: word.confidence,
      ...(word.speaker === undefined ? {} : { speaker: word.speaker }),
    }),
  );
  const sourceStartMs =
    words[0]?.startMs ?? Math.round(result.start * 1_000);
  const sourceEndMs =
    words.at(-1)?.endMs ?? Math.round((result.start + result.duration) * 1_000);

  return Object.freeze({
    id: `${result.metadata.request_id}:${sourceStartMs}:${sourceEndMs}:${alternative.transcript}`,
    text: alternative.transcript,
    words,
    sourceStartMs,
    sourceEndMs,
    receivedAtMs,
    isFinal: result.is_final === true,
  });
}

interface DeepgramWord {
  readonly word: string;
  readonly punctuated_word?: string;
  readonly start: number;
  readonly end: number;
  readonly confidence: number;
  readonly speaker?: number;
}

interface DeepgramResult {
  readonly type: "Results";
  readonly start: number;
  readonly duration: number;
  readonly is_final?: boolean;
  readonly metadata: { readonly request_id: string };
  readonly channel: {
    readonly alternatives: readonly {
      readonly transcript: string;
      readonly words: readonly DeepgramWord[];
    }[];
  };
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null;
}

function isDeepgramWord(value: unknown): value is DeepgramWord {
  if (!isRecord(value)) return false;
  return (
    typeof value.word === "string" &&
    typeof value.start === "number" &&
    typeof value.end === "number" &&
    typeof value.confidence === "number" &&
    (value.punctuated_word === undefined ||
      typeof value.punctuated_word === "string") &&
    (value.speaker === undefined || typeof value.speaker === "number")
  );
}

function parseDeepgramResult(value: unknown): DeepgramResult | undefined {
  if (!isRecord(value) || value.type !== "Results") return undefined;
  if (
    typeof value.start !== "number" ||
    typeof value.duration !== "number" ||
    !isRecord(value.metadata) ||
    typeof value.metadata.request_id !== "string" ||
    !isRecord(value.channel) ||
    !Array.isArray(value.channel.alternatives)
  ) {
    return undefined;
  }
  const alternatives = value.channel.alternatives;
  if (
    !alternatives.every(
      (alternative) =>
        isRecord(alternative) &&
        typeof alternative.transcript === "string" &&
        Array.isArray(alternative.words) &&
        alternative.words.every(isDeepgramWord),
    )
  ) {
    return undefined;
  }
  return value as unknown as DeepgramResult;
}

class SdkDeepgramConnectionFactory implements DeepgramConnectionFactory {
  readonly #client: DeepgramClient;
  readonly #model: string;
  readonly #language: string;

  constructor(options: DeepgramStreamingTranscriberOptions) {
    this.#client = new DeepgramClient({ apiKey: options.apiKey });
    this.#model = options.model ?? "nova-3";
    this.#language = options.language ?? "en";
  }

  connect(signal: AbortSignal): Promise<DeepgramConnection> {
    return this.#client.listen.v1
      .connect({
        model: this.#model,
        language: this.#language,
        encoding: "linear16",
        sample_rate: 16_000,
        channels: 1,
        punctuate: "true",
        smart_format: "true",
        diarize: "true",
        interim_results: "true",
        abortSignal: signal,
      })
      .then((socket) => ({
        on: (
          event: "message" | "error" | "close",
          callback:
            | ((message: unknown) => void)
            | ((error: Error) => void)
            | (() => void),
        ) => {
          if (event === "message") {
            socket.on("message", callback as (message: unknown) => void);
          } else if (event === "error") {
            socket.on("error", callback as (error: Error) => void);
          } else {
            socket.on("close", callback as () => void);
          }
        },
        connect: () => {
          socket.connect();
          return socket;
        },
        waitForOpen: () => socket.waitForOpen(),
        sendMedia: (data: ArrayBufferView) => socket.sendMedia(data),
        sendFinalize: (message: { readonly type: "Finalize" }) =>
          socket.sendFinalize(message),
        sendCloseStream: (message: { readonly type: "CloseStream" }) =>
          socket.sendCloseStream(message),
        close: () => socket.close(),
      }));
  }
}

export class DeepgramStreamingTranscriber implements StreamingTranscriber {
  readonly #connections: DeepgramConnectionFactory;
  readonly #clock: Clock;

  constructor(
    options: DeepgramStreamingTranscriberOptions,
    connections: DeepgramConnectionFactory = new SdkDeepgramConnectionFactory(
      options,
    ),
  ) {
    this.#connections = connections;
    this.#clock = options.clock ?? systemClock;
  }

  async run(
    source: AudioSource,
    onTranscript: (event: TranscriptEvent) => void,
    signal: AbortSignal,
  ): Promise<void> {
    signal.throwIfAborted();
    const connectionController = new AbortController();
    const combinedSignal = AbortSignal.any([
      signal,
      connectionController.signal,
    ]);
    const connection = await this.#connections.connect(combinedSignal);
    let sourceTimeOriginMs: number | null = null;
    let connectionError: Error | undefined;
    let markClosed: (() => void) | undefined;
    const closed = new Promise<void>((resolve) => {
      markClosed = resolve;
    });

    connection.on("error", (error) => {
      connectionError = error;
      connectionController.abort(error);
    });
    connection.on("close", () => markClosed?.());
    connection.on("message", (message) => {
      const result = parseDeepgramResult(message);
      if (result === undefined) return;
      const receivedAtMs = this.#clock.now();
      const segment = segmentFromResult(result, receivedAtMs);
      if (segment === undefined) return;
      const sourceAgeMs =
        sourceTimeOriginMs === null
          ? null
          : Math.max(0, receivedAtMs - sourceTimeOriginMs - segment.sourceEndMs);
      onTranscript(Object.freeze({ segment, sourceAgeMs }));
    });

    connection.connect();
    await waitForOpenOrAbort(connection, combinedSignal);

    try {
      await source.run((chunk: AudioChunk) => {
        if (sourceTimeOriginMs === null && chunk.sourceTimestampMs !== null) {
          sourceTimeOriginMs = chunk.sourceTimestampMs;
        }
        connection.sendMedia(chunk.data);
      }, combinedSignal);
      if (connectionError !== undefined) throw connectionError;
      connection.sendFinalize({ type: "Finalize" });
      connection.sendCloseStream({ type: "CloseStream" });
      await closed;
    } finally {
      connection.close();
    }
  }
}
