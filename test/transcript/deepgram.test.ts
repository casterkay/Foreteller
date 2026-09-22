import { describe, expect, it } from "vitest";

import type { Clock } from "../../src/core/clock.js";
import type { AudioSource } from "../../src/transcript/audio.js";
import {
  DeepgramStreamingTranscriber,
  type DeepgramConnection,
  type DeepgramConnectionFactory,
} from "../../src/transcript/deepgram.js";

class FakeConnection implements DeepgramConnection {
  messageHandler: ((message: unknown) => void) | undefined;
  errorHandler: ((error: Error) => void) | undefined;
  closed = false;

  on(event: "message", callback: (message: unknown) => void): void;
  on(event: "error", callback: (error: Error) => void): void;
  on(event: "close", callback: () => void): void;
  on(
    event: "message" | "error" | "close",
    callback:
      | ((message: unknown) => void)
      | ((error: Error) => void)
      | (() => void),
  ): void {
    if (event === "message") {
      this.messageHandler = callback as (message: unknown) => void;
    } else if (event === "error") {
      this.errorHandler = callback as (error: Error) => void;
    } else {
      this.closeHandler = callback as () => void;
    }
  }

  connect(): DeepgramConnection {
    return this;
  }
  waitForOpen(): Promise<unknown> {
    return Promise.resolve();
  }
  sendMedia(): void {
    this.messageHandler?.({
      type: "Results",
      start: 0,
      duration: 2,
      is_final: false,
      metadata: { request_id: "request" },
      channel: {
        alternatives: [
          {
            transcript: "Hello world",
            words: [
              { word: "hello", start: 1, end: 1.4, confidence: 0.9, speaker: 0 },
              { word: "world", start: 1.5, end: 2, confidence: 0.95, speaker: 0 },
            ],
          },
        ],
      },
    });
  }
  sendFinalize(): void {}
  sendCloseStream(): void {
    this.closeHandler?.();
  }
  close(): void {
    this.closed = true;
  }

  private closeHandler: (() => void) | undefined;
}

describe("DeepgramStreamingTranscriber", () => {
  it("maps interim results and identifies real source timestamp age", async () => {
    const connection = new FakeConnection();
    const factory: DeepgramConnectionFactory = {
      connect: async () => connection,
    };
    const clock: Clock = { now: () => 5_000 };
    const source: AudioSource = {
      run: async (onChunk) => {
        onChunk({
          data: new Uint8Array([1, 2]),
          receivedAtMs: 3_100,
          sourceTimestampMs: 1_000,
          sourceAgeMs: 2_100,
        });
      },
    };
    const events: unknown[] = [];
    const transcriber = new DeepgramStreamingTranscriber(
      { apiKey: "test", clock },
      factory,
    );

    await transcriber.run(
      source,
      (event) => events.push(event),
      new AbortController().signal,
    );

    expect(events).toEqual([
      expect.objectContaining({
        observedAgeMs: 2_000,
        observedAgeBasis: "source_timestamp",
        segment: expect.objectContaining({
          isFinal: false,
          sourceStartMs: 2_000,
          sourceEndMs: 3_000,
        }),
      }),
    ]);
    expect(connection.closed).toBe(true);
  });

  it("labels stream-relative timing as pipeline age", async () => {
    const connection = new FakeConnection();
    const source: AudioSource = {
      run: async (onChunk) => {
        onChunk({
          data: new Uint8Array([1]),
          receivedAtMs: 3_000,
          sourceTimestampMs: null,
          sourceAgeMs: null,
        });
      },
    };
    const events: Array<{ observedAgeMs: number; observedAgeBasis: string }> = [];
    const transcriber = new DeepgramStreamingTranscriber(
      { apiKey: "test", clock: { now: () => 5_500 } },
      { connect: async () => connection },
    );

    await transcriber.run(
      source,
      (event) => events.push(event),
      new AbortController().signal,
    );

    expect(events).toEqual([
      expect.objectContaining({
        observedAgeMs: 500,
        observedAgeBasis: "pipeline_clock",
      }),
    ]);
  });
});
