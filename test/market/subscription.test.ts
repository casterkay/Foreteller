import { describe, expect, it, vi } from "vitest";

import type { OrderBook } from "@polymarket/client";

import {
  MarketBookSubscriber,
  MarketSubscriptionTimeoutError,
  type MarketStreamEvent,
  type MarketSubscriptionHandle,
} from "../../src/market/subscription.js";

describe("MarketBookSubscriber", () => {
  it("does not become ready until every subscribed token has a fresh snapshot", async () => {
    const handle = new BlockingHandle();
    const fetchOrderBook = vi.fn(async ({ assetId }: { assetId: string }) =>
      snapshot(assetId),
    );
    const subscriber = new MarketBookSubscriber(
      {
        fetchOrderBook,
        subscribe: async () => handle,
      },
      {
        tokenIds: ["yes", "no"],
        tickSizes: new Map([
          ["yes", 0.01],
          ["no", 0.01],
        ]),
        now: () => 100,
      },
    );

    expect(subscriber.ready()).toBe(false);
    subscriber.start();

    await vi.waitFor(() => expect(subscriber.ready()).toBe(true));
    expect(fetchOrderBook).toHaveBeenCalledTimes(2);
    expect(subscriber.book("yes").sourceTimestampMs).toBe(90);

    await subscriber.stop();
  });

  it("stops while a stream handshake is still unanswered", async () => {
    const errors: Error[] = [];
    const publishedSynchronizedBook: boolean[] = [];
    const lateHandle = new BlockingHandle();
    const closeLateHandle = vi.spyOn(lateHandle, "close");
    const subscriber = new MarketBookSubscriber(
      {
        fetchOrderBook: () => Promise.reject(new Error("not reached")) as Promise<OrderBook>,

        // A handshake the venue answers only after it has been abandoned.
        subscribe: () => new Promise<MarketSubscriptionHandle>((resolve) => {
          setTimeout(() => resolve(lateHandle), 30);
        }),
      },
      {
        tokenIds: ["yes"],
        tickSizes: new Map([["yes", 0.01]]),
        startupTimeoutMs: 10_000,
        onBook: (book) => publishedSynchronizedBook.push(book.synchronized),
        onError: (error) => errors.push(error),
      },
    );

    subscriber.start();
    await subscriber.stop();

    expect(errors).toEqual([]);
    await vi.waitFor(() => expect(closeLateHandle).toHaveBeenCalled());
    expect(publishedSynchronizedBook).not.toContain(true);
  });

  it("stops even when closing the venue handle never completes", async () => {
    const errors: Error[] = [];
    const handle: MarketSubscriptionHandle = {
      close: () => new Promise<void>(() => undefined),
      [Symbol.asyncIterator]: () => ({ next: () => new Promise(() => undefined) }),
    };
    const subscriber = new MarketBookSubscriber(
      {
        fetchOrderBook: async ({ assetId }: { assetId: string }) => snapshot(assetId),
        subscribe: async () => handle,
      },
      {
        tokenIds: ["yes"],
        tickSizes: new Map([["yes", 0.01]]),
        stopTimeoutMs: 20,
        onError: (error) => errors.push(error),
      },
    );

    subscriber.start();
    await vi.waitFor(() => expect(subscriber.ready()).toBe(true));
    await subscriber.stop();

    expect(errors.map((error) => error.message)).toEqual([
      "Abandoned an unresponsive market subscription while stopping",
    ]);
  });

  it("abandons a stalled handshake and reconnects without waiting for it", async () => {
    const errors: Error[] = [];
    const stalled = new BlockingHandle();
    const live = new BlockingHandle();
    let attempt = 0;
    const subscriber = new MarketBookSubscriber(
      {
        fetchOrderBook: async ({ assetId }: { assetId: string }) => snapshot(assetId),
        subscribe: () => {
          attempt += 1;
          const handle = attempt === 1 ? stalled : live;
          return attempt === 1
            ? new Promise<MarketSubscriptionHandle>((resolve) => setTimeout(() => resolve(handle), 5_000))
            : Promise.resolve(handle);
        },
      },
      {
        tokenIds: ["yes"],
        tickSizes: new Map([["yes", 0.01]]),
        startupTimeoutMs: 20,
        reconnectDelayMs: 0,
        onError: (error) => errors.push(error),
      },
    );

    subscriber.start();

    await vi.waitFor(() => expect(subscriber.ready()).toBe(true));
    expect(errors[0]).toBeInstanceOf(MarketSubscriptionTimeoutError);

    await subscriber.stop();
  });
});

class BlockingHandle implements MarketSubscriptionHandle {
  #closed = false;
  #resolve: (() => void) | undefined;

  public async close(): Promise<void> {
    this.#closed = true;
    this.#resolve?.();
  }

  public async *[Symbol.asyncIterator](): AsyncGenerator<MarketStreamEvent> {
    await new Promise<void>((resolve) => {
      this.#resolve = resolve;
      if (this.#closed) resolve();
    });
  }
}

function snapshot(assetId: string): OrderBook {
  return {
    assetId,
    tokenId: assetId,
    conditionId: "condition",
    timestamp: 90,
    bids: [{ price: "0.4", size: "2" }],
    asks: [{ price: "0.5", size: "2" }],
    minOrderSize: "1",
    tickSize: 0.01,
    negRisk: false,
    hash: "hash",
  } as unknown as OrderBook;
}
