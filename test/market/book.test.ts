import { describe, expect, it } from "vitest";

import {
  applyBookDelta,
  applyBookSnapshot,
  applyTickSizeChange,
  emptyBook,
  isBookUsable,
} from "../../src/market/book.js";
import { estimateBuyExecution } from "../../src/market/execution-cost.js";

describe("BookState", () => {
  it("sorts bids descending and asks ascending regardless of snapshot order", () => {
    const book = applyBookSnapshot({
      tokenId: "yes",
      bids: [
        { price: 0.4, size: 2 },
        { price: 0.7, size: 1 },
      ],
      asks: [
        { price: 0.8, size: 1 },
        { price: 0.5, size: 3 },
      ],
      tickSize: 0.01,
      sourceTimestampMs: 100,
      receivedAtMs: 110,
    });

    expect(book.bids.map((level) => level.price)).toEqual([0.7, 0.4]);
    expect(book.asks.map((level) => level.price)).toEqual([0.5, 0.8]);
    expect(Object.isFrozen(book)).toBe(true);
    expect(Object.isFrozen(book.asks)).toBe(true);
  });

  it("removes a price level when a delta carries zero size", () => {
    const snapshot = applyBookSnapshot({
      tokenId: "yes",
      bids: [{ price: 0.4, size: 2 }],
      asks: [{ price: 0.5, size: 3 }],
      tickSize: 0.01,
      receivedAtMs: 100,
    });
    const updated = applyBookDelta(snapshot, {
      tokenId: "yes",
      side: "SELL",
      price: 0.5,
      size: 0,
      receivedAtMs: 110,
    });

    expect(updated.asks).toEqual([]);
    expect(snapshot.asks).toEqual([{ price: 0.5, size: 3 }]);
  });

  it("rejects unsynchronized and stale books for execution", () => {
    const unsynchronized = emptyBook("yes", 0.01, 100);
    const synchronized = applyBookSnapshot({
      tokenId: "yes",
      bids: [],
      asks: [{ price: 0.5, size: 1 }],
      tickSize: 0.01,
      sourceTimestampMs: 100,
      receivedAtMs: 110,
    });

    expect(isBookUsable(unsynchronized, 100, 101)).toBe(false);
    expect(isBookUsable(synchronized, 50, 151)).toBe(false);
    expect(isBookUsable(synchronized, 50, 150)).toBe(true);
  });

  it("fails closed when a delayed delta is older than the snapshot", () => {
    const snapshot = applyBookSnapshot({
      tokenId: "yes",
      bids: [{ price: 0.4, size: 2 }],
      asks: [],
      tickSize: 0.01,
      sourceTimestampMs: 200,
      receivedAtMs: 210,
    });

    const delayed = applyBookDelta(snapshot, {
      tokenId: "yes",
      side: "BUY",
      price: 0.4,
      size: 9,
      sourceTimestampMs: 199,
      receivedAtMs: 211,
    });

    expect(delayed.synchronized).toBe(false);
    expect(delayed.bids[0]?.size).toBe(2);
  });

  it("requires a fresh snapshot after a tick-size change", () => {
    const snapshot = applyBookSnapshot({
      tokenId: "yes",
      bids: [{ price: 0.4, size: 2 }],
      asks: [{ price: 0.5, size: 3 }],
      tickSize: 0.01,
      receivedAtMs: 100,
    });
    const changed = applyTickSizeChange(snapshot, {
      tokenId: "yes",
      tickSize: 0.005,
      receivedAtMs: 110,
    });
    const refreshed = applyBookSnapshot({
      tokenId: "yes",
      bids: [{ price: 0.405, size: 2 }],
      asks: [{ price: 0.505, size: 3 }],
      tickSize: 0.005,
      receivedAtMs: 120,
    });

    expect(changed.tickSize).toBe(0.005);
    expect(changed.synchronized).toBe(false);
    expect(isBookUsable(changed, 100, 111)).toBe(false);
    expect(refreshed.synchronized).toBe(true);
    expect(refreshed.bids[0]?.price).toBe(0.405);
  });
});

describe("estimateBuyExecution", () => {
  it("walks ask depth and includes the Polymarket taker-fee curve", () => {
    const book = applyBookSnapshot({
      tokenId: "yes",
      bids: [],
      asks: [
        { price: 0.4, size: 3 },
        { price: 0.5, size: 2 },
      ],
      tickSize: 0.01,
      receivedAtMs: 100,
    });

    const result = estimateBuyExecution(book, 5, { rate: 0.1, exponent: 1 });

    expect(result.complete).toBe(true);
    expect(result.grossCost).toBeCloseTo(2.2);
    expect(result.fee).toBeCloseTo(0.122);
    expect(result.totalCost).toBeCloseTo(2.322);
    expect(result.averageCostPerShare).toBeCloseTo(0.4644);
  });

  it("reports the available partial fill instead of pretending shallow depth is complete", () => {
    const book = applyBookSnapshot({
      tokenId: "yes",
      bids: [],
      asks: [{ price: 0.4, size: 2 }],
      tickSize: 0.01,
      receivedAtMs: 100,
    });

    const result = estimateBuyExecution(book, 3, undefined);

    expect(result.complete).toBe(false);
    expect(result.filledShares).toBe(2);
    expect(result.unfilledShares).toBe(1);
    expect(result.averageCostPerShare).toBe(0.4);
  });
});
