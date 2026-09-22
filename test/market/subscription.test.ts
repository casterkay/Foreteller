import { describe, expect, it, vi } from "vitest";

import type { OrderBook } from "@polymarket/client";

import {
  MarketBookSubscriber,
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
