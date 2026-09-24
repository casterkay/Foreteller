import { createPublicClient, type OrderBook } from "@polymarket/client";

import {
  applyBookDelta,
  applyBookSnapshot,
  applyTickSizeChange,
  emptyBook,
  markBookUnsynchronized,
} from "./book.js";
import type { BookState } from "./types.js";

export type MarketStreamEvent =
  | {
      readonly type: "book";
      readonly payload: {
        readonly assetId: string;
        readonly bids: readonly { readonly price: string; readonly size: string }[];
        readonly asks: readonly { readonly price: string; readonly size: string }[];
        readonly tickSize: string | null | undefined;
        readonly timestamp: number | null | undefined;
      };
    }
  | {
      readonly type: "price_change";
      readonly payload: {
        readonly timestamp: number | null | undefined;
        readonly priceChanges: readonly {
          readonly assetId: string;
          readonly price: string;
          readonly size: string;
          readonly side: "BUY" | "SELL";
        }[];
      };
    }
  | {
      readonly type: "tick_size_change";
      readonly payload: {
        readonly assetId: string;
        readonly newTickSize: string;
        readonly timestamp: number | null | undefined;
      };
    };

export interface MarketSubscriptionHandle extends AsyncIterable<MarketStreamEvent> {
  close(): Promise<void>;
}

export interface MarketSubscriptionClient {
  fetchOrderBook(request: { readonly assetId: string }): Promise<OrderBook>;
  subscribe(subscriptions: readonly { readonly topic: "market"; readonly assetIds: readonly string[] }[]): Promise<MarketSubscriptionHandle>;
}

export function createPolymarketSubscriptionClient(): MarketSubscriptionClient {
  const client = createPublicClient();
  return Object.freeze({
    fetchOrderBook: (request: { readonly assetId: string }) => client.fetchOrderBook(request),
    subscribe: async (subscriptions: readonly {
      readonly topic: "market";
      readonly assetIds: readonly string[];
    }[]) => client.subscribe(subscriptions) as unknown as MarketSubscriptionHandle,
  });
}

export interface MarketBookSubscriberOptions {
  readonly tokenIds: readonly string[];
  readonly tickSizes: ReadonlyMap<string, number>;
  readonly reconnectDelayMs?: number;

  /** Bounds a stream handshake and its first snapshots, which the venue client cannot cancel. */
  readonly startupTimeoutMs?: number;

  /** Bounds how long `stop()` waits for the venue handle and stream loop to unwind. */
  readonly stopTimeoutMs?: number;
  readonly now?: () => number;
  readonly onBook?: (book: BookState) => void;
  readonly onError?: (error: Error) => void;
}

export class MarketSubscriptionTimeoutError extends Error {}
export class MarketSubscriptionStoppedError extends Error {
  public constructor() {
    super("Market subscription stopped");
  }
}

export class MarketBookSubscriber {
  readonly #books = new Map<string, BookState>();
  readonly #tokenIds: readonly string[];
  readonly #tickSizes: ReadonlyMap<string, number>;
  readonly #reconnectDelayMs: number;
  readonly #startupTimeoutMs: number;
  readonly #stopTimeoutMs: number;
  readonly #now: () => number;
  readonly #onBook: ((book: BookState) => void) | undefined;
  readonly #onError: ((error: Error) => void) | undefined;
  #running = false;
  #task: Promise<void> | undefined;
  #handle: MarketSubscriptionHandle | undefined;
  #shutdown = new AbortController();

  public constructor(
    private readonly client: MarketSubscriptionClient,
    options: MarketBookSubscriberOptions,
  ) {
    if (options.tokenIds.length === 0) throw new Error("At least one token ID is required");
    this.#tokenIds = Object.freeze([...new Set(options.tokenIds)]);
    if (this.#tokenIds.length !== options.tokenIds.length) throw new Error("Duplicate token IDs");
    this.#tickSizes = options.tickSizes;
    this.#reconnectDelayMs = options.reconnectDelayMs ?? 1_000;
    if (!Number.isFinite(this.#reconnectDelayMs) || this.#reconnectDelayMs < 0) {
      throw new Error("Reconnect delay must be non-negative");
    }
    this.#startupTimeoutMs = positiveDuration(options.startupTimeoutMs ?? 10_000, "Startup timeout");
    this.#stopTimeoutMs = positiveDuration(options.stopTimeoutMs ?? 5_000, "Stop timeout");
    this.#now = options.now ?? Date.now;
    this.#onBook = options.onBook;
    this.#onError = options.onError;
    for (const tokenId of this.#tokenIds) {
      const tickSize = this.#tickSizes.get(tokenId);
      if (tickSize === undefined) throw new Error(`Missing tick size for ${tokenId}`);
      this.#books.set(tokenId, emptyBook(tokenId, tickSize, this.#now()));
    }
  }

  public start(): void {
    if (this.#running) return;
    this.#running = true;
    this.#shutdown = new AbortController();
    this.#task = this.run(this.#shutdown.signal);
  }

  /**
   * Always completes. The venue handle and the stream loop are given a bounded
   * window to unwind; past it the subscriber is abandoned rather than allowed to
   * block session replacement or process shutdown. Book callbacks stop first, so
   * abandoned work cannot reach a consumer that has already torn down.
   */
  public async stop(): Promise<void> {
    if (!this.#running) return;
    this.#running = false;
    this.#shutdown.abort(new MarketSubscriptionStoppedError());
    const handle = this.#handle;
    const task = this.#task;
    this.#handle = undefined;
    this.#task = undefined;
    try {
      await withDeadline(
        (async () => {
          await handle?.close();
          await task;
        })(),
        this.#stopTimeoutMs,
      );
    } catch (error: unknown) {
      if (error instanceof MarketSubscriptionTimeoutError) {
        this.#onError?.(new MarketSubscriptionTimeoutError(
          "Abandoned an unresponsive market subscription while stopping",
        ));
        return;
      }
      this.#onError?.(asError(error));
    }
  }

  public book(tokenId: string): BookState {
    const book = this.#books.get(tokenId);
    if (book === undefined) throw new Error(`No subscription for token ${tokenId}`);
    return book;
  }

  public ready(): boolean {
    return [...this.#books.values()].every((book) => book.synchronized);
  }

  private async run(signal: AbortSignal): Promise<void> {
    while (this.#running) {
      try {
        this.markUnsynchronized();
        const connection = await withDeadline(
          this.client.subscribe([{ topic: "market", assetIds: this.#tokenIds }]),
          this.#startupTimeoutMs,
          signal,
          (late) => void late.close().catch(() => undefined),
        );
        this.#handle = connection;
        await withDeadline(this.refreshSnapshots(connection), this.#startupTimeoutMs, signal);
        for await (const event of connection) {
          if (!this.#running) break;
          this.apply(event);
        }
      } catch (error: unknown) {
        if (!signal.aborted) this.#onError?.(asError(error));
      } finally {
        this.#handle = undefined;
        this.markUnsynchronized();
      }
      if (this.#running) await wait(this.#reconnectDelayMs, signal);
    }
  }

  private async refreshSnapshots(connection: MarketSubscriptionHandle): Promise<void> {
    const snapshots = await Promise.all(
      this.#tokenIds.map(async (tokenId) => {
        const book = await this.client.fetchOrderBook({ assetId: tokenId });
        if (book.assetId !== tokenId) {
          throw new Error(`Snapshot token mismatch: expected ${tokenId}, received ${book.assetId}`);
        }
        return applyBookSnapshot({
          tokenId,
          bids: parseLevels(book.bids, "snapshot bids"),
          asks: parseLevels(book.asks, "snapshot asks"),
          tickSize: parsePositive(book.tickSize, "snapshot tick size"),
          ...(book.timestamp === null || book.timestamp === undefined
            ? {}
            : { sourceTimestampMs: parseTimestamp(book.timestamp) }),
          receivedAtMs: this.#now(),
        });
      }),
    );

    // Snapshots that arrive after their connection was abandoned describe a book we no longer track.
    if (this.#handle !== connection) return;
    for (const book of snapshots) this.setBook(book);
  }

  private apply(event: MarketStreamEvent): void {
    switch (event.type) {
      case "book": {
        if (!this.#books.has(event.payload.assetId)) return;
        const previous = this.book(event.payload.assetId);
        const tickSize = event.payload.tickSize === null || event.payload.tickSize === undefined
          ? previous.tickSize
          : parsePositive(event.payload.tickSize, "book tick size");
        this.setBook(
          applyBookSnapshot({
            tokenId: event.payload.assetId,
            bids: parseLevels(event.payload.bids, "book bids"),
            asks: parseLevels(event.payload.asks, "book asks"),
            tickSize,
            ...(event.payload.timestamp === null || event.payload.timestamp === undefined
              ? {}
              : { sourceTimestampMs: parseTimestamp(event.payload.timestamp) }),
            receivedAtMs: this.#now(),
          }),
        );
        return;
      }
      case "price_change": {
        for (const change of event.payload.priceChanges) {
          if (!this.#books.has(change.assetId)) continue;
          const timestamp = event.payload.timestamp;
          this.setBook(
            applyBookDelta(this.book(change.assetId), {
              tokenId: change.assetId,
              side: change.side,
              price: parsePositive(change.price, "price change price"),
              size: parseNonNegative(change.size, "price change size"),
              ...(timestamp === null || timestamp === undefined
                ? {}
                : { sourceTimestampMs: parseTimestamp(timestamp) }),
              receivedAtMs: this.#now(),
            }),
          );
        }
        return;
      }
      case "tick_size_change": {
        if (!this.#books.has(event.payload.assetId)) return;
        const timestamp = event.payload.timestamp;
        this.setBook(
          applyTickSizeChange(this.book(event.payload.assetId), {
            tokenId: event.payload.assetId,
            tickSize: parsePositive(event.payload.newTickSize, "new tick size"),
            ...(timestamp === null || timestamp === undefined
              ? {}
              : { sourceTimestampMs: parseTimestamp(timestamp) }),
            receivedAtMs: this.#now(),
          }),
        );
      }
    }
  }

  private markUnsynchronized(): void {
    for (const book of this.#books.values()) {
      this.setBook(markBookUnsynchronized(book, this.#now()));
    }
  }

  private setBook(book: BookState): void {
    this.#books.set(book.tokenId, book);
    if (this.#running) this.#onBook?.(book);
  }
}

function parseLevels(
  levels: readonly { readonly price: string; readonly size: string }[],
  label: string,
): readonly { readonly price: number; readonly size: number }[] {
  return levels.map((level) => ({
    price: parsePositive(level.price, `${label} price`),
    size: parseNonNegative(level.size, `${label} size`),
  }));
}

function parsePositive(value: string | number, field: string): number {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) throw new Error(`${field} must be positive`);
  return number;
}

function parseNonNegative(value: string | number, field: string): number {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) throw new Error(`${field} must be non-negative`);
  return number;
}

function parseTimestamp(value: number): number {
  if (!Number.isFinite(value) || value < 0) throw new Error("Market source timestamp is invalid");
  return value;
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error("Market subscription failed", { cause: error });
}

function positiveDuration(value: number, label: string): number {
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${label} must be positive`);
  return value;
}

function wait(delayMs: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(finish, delayMs);
    signal.addEventListener("abort", finish, { once: true });
    function finish(): void {
      clearTimeout(timer);
      signal.removeEventListener("abort", finish);
      resolve();
    }
  });
}

/**
 * The venue client accepts no cancellation, so a stalled handshake or snapshot can
 * only be bounded and abandoned. A value that arrives after the wait gave up is
 * handed to `discard` so an established connection is still released.
 */
async function withDeadline<T>(
  operation: Promise<T>,
  timeoutMs: number,
  cancellation?: AbortSignal,
  discard: (value: T) => void = () => undefined,
): Promise<T> {
  const deadline = new AbortController();
  const timer = setTimeout(
    () => deadline.abort(new MarketSubscriptionTimeoutError(
      `Market subscription call exceeded ${String(timeoutMs)} ms`,
    )),
    timeoutMs,
  );
  const onCancellation = (): void => deadline.abort(asError(cancellation?.reason));
  if (cancellation?.aborted === true) onCancellation();
  else cancellation?.addEventListener("abort", onCancellation, { once: true });
  try {
    return await Promise.race([operation, rejectOnAbort(deadline.signal)]);
  } catch (error: unknown) {
    if (deadline.signal.aborted) void operation.then(discard, () => undefined);
    throw error;
  } finally {
    clearTimeout(timer);
    cancellation?.removeEventListener("abort", onCancellation);
  }
}

function rejectOnAbort(signal: AbortSignal): Promise<never> {
  return new Promise((_resolve, reject) => {
    if (signal.aborted) {
      reject(asError(signal.reason));
      return;
    }
    signal.addEventListener("abort", () => reject(asError(signal.reason)), { once: true });
  });
}
