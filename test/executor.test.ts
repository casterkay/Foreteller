import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type {
  BookSnapshot,
  ExecutionRequest,
  FillRecord,
  MarketDefinition,
  OrderIntent,
} from "../src/domain/types.js";
import {
  ReconciliationRequiredError,
  SerializedExecutor,
  roundPriceDown,
  type ExecutorOptions,
  type FakMarketBuy,
  type VenueOrderReference,
  type VenueOrderResult,
  type VenueTrader,
} from "../src/execution/index.js";
import { SqliteStore } from "../src/storage/index.js";

const temporaryDirectories: string[] = [];

function databasePath(): string {
  const directory = mkdtempSync(join(tmpdir(), "foreteller-executor-"));
  temporaryDirectories.push(directory);
  return join(directory, "test.sqlite");
}

const timestamp = Date.UTC(2026, 8, 22, 12);

const market: MarketDefinition = {
  eventId: "event-1",
  marketId: "market-1",
  question: "Will the speaker say alpha?",
  description: "Single mention market",
  yesTokenId: "yes-1",
  noTokenId: "no-1",
  tickSize: 0.01,
  minimumOrderSize: 1,
  negRisk: false,
  acceptingOrders: true,
  feeRate: 0.02,
  term: {
    marketId: "market-1",
    label: "alpha",
    acceptedForms: ["alpha"],
    excludedForms: [],
    speakerScope: "primary",
    windowStartMs: timestamp,
    windowEndMs: timestamp + 60_000,
  },
};

const book: BookSnapshot = {
  tokenId: "yes-1",
  bids: [{ price: 0.97, size: 100 }],
  asks: [{ price: 0.98, size: 100 }],
  tickSize: 0.01,
  receivedAtMs: timestamp,
  synchronized: true,
};

function orderIntent(overrides: Partial<OrderIntent> = {}): OrderIntent {
  return {
    id: "intent-1",
    sessionId: "session-1",
    eventId: "event-1",
    marketId: "market-1",
    tokenId: "yes-1",
    strategy: "sniper",
    notional: 5,
    maxPrice: 0.987,
    evidenceJson: "{}",
    createdAtMs: timestamp,
    ...overrides,
  };
}

function request(overrides: Partial<OrderIntent> = {}): ExecutionRequest {
  return {
    intent: orderIntent(overrides),
    market,
    book,
    observedAgeMs: 100,
    observedAgeBasis: "source_timestamp",
  };
}

const options: ExecutorOptions = {
  liveTrading: true,
  requestTimeoutMs: 20,
  limits: {
    dailyNotionalLimit: 250,
    eventNotionalLimit: 120,
    forecastMarketAllowance: 15,
    sniperMarketAllowance: 20,
    maximumSourceAgeMs: 45_000,
  },
};

class TraderStub implements VenueTrader {
  public readonly submissions: FakMarketBuy[] = [];
  public readonly reconciliations: VenueOrderReference[] = [];
  public balance = 100;
  public submission: (order: FakMarketBuy, signal: AbortSignal) => Promise<VenueOrderResult> =
    async () => ({ status: "cancelled", venueOrderId: "venue-1" });
  public reconciliation: (
    reference: VenueOrderReference,
    signal: AbortSignal,
  ) => Promise<VenueOrderResult> = async () => ({ status: "not_found" });

  public async availableBalance(_signal: AbortSignal): Promise<number> {
    return this.balance;
  }

  public async submitFakMarketBuy(
    order: FakMarketBuy,
    signal: AbortSignal,
  ): Promise<VenueOrderResult> {
    this.submissions.push(order);
    return this.submission(order, signal);
  }

  public async reconcileOrder(
    reference: VenueOrderReference,
    signal: AbortSignal,
  ): Promise<VenueOrderResult> {
    this.reconciliations.push(reference);
    return this.reconciliation(reference, signal);
  }
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function createStore(path = databasePath()): SqliteStore {
  const store = new SqliteStore(path);
  store.recordSession("session-1", "live", timestamp);
  return store;
}

describe("SerializedExecutor", () => {
  it("submits a rounded FAK BUY and journals idempotent partial fills", async () => {
    const store = createStore();
    const trader = new TraderStub();
    const partialFill: FillRecord = {
      venueTradeId: "trade-1",
      venueOrderId: "venue-1",
      intentId: "intent-1",
      price: 0.98,
      shares: 2,
      fee: 0.01,
      status: "confirmed",
      occurredAtMs: timestamp + 1,
    };
    trader.submission = async () => ({
      status: "partially_filled",
      venueOrderId: "venue-1",
      fills: [partialFill, partialFill],
    });
    const executor = new SerializedExecutor(store, trader, options, { now: () => timestamp + 2 });
    await executor.reconcileStartup();

    await expect(executor.execute(request())).resolves.toEqual({
      intentId: "intent-1",
      status: "partially_filled",
      venueOrderId: "venue-1",
    });
    expect(trader.submissions).toEqual([
      {
        clientOrderId: "intent-1",
        tokenId: "yes-1",
        notional: 5,
        maxPrice: 0.98,
        side: "BUY",
        timeInForce: "FAK",
      },
    ]);
    expect(store.exposure({ eventId: "event-1" })).toBe(1.96);
    store.close();
  });

  it("records a timed-out submission as unknown and blocks another order", async () => {
    const store = createStore();
    const trader = new TraderStub();
    trader.submission = (_order, signal) =>
      new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      });
    const executor = new SerializedExecutor(
      store,
      trader,
      { ...options, requestTimeoutMs: 5 },
      { now: () => timestamp + 2 },
    );
    await executor.reconcileStartup();

    const result = await executor.execute(request());
    expect(result.status).toBe("unknown");
    expect(store.getOrder("intent-1")?.status).toBe("unknown");
    expect(store.exposure({ eventId: "event-1" })).toBe(5);
    await expect(executor.execute(request({ id: "intent-2" }))).rejects.toBeInstanceOf(
      ReconciliationRequiredError,
    );
    expect(trader.submissions).toHaveLength(1);
    store.close();
  });

  it("blocks after restart until a reserved intent is reconciled", async () => {
    const path = databasePath();
    const first = createStore(path);
    expect(
      first.reserveOrder(orderIntent(), 0.1, {
        daily: 250,
        event: 120,
        strategyMarket: 20,
        walletAvailable: 100,
      }).accepted,
    ).toBe(true);
    first.close();

    const restarted = new SqliteStore(path);
    const trader = new TraderStub();
    const executor = new SerializedExecutor(
      restarted,
      trader,
      { ...options, liveTrading: false },
      { now: () => timestamp + 2 },
    );
    await expect(executor.execute(request({ id: "intent-2" }))).rejects.toBeInstanceOf(
      ReconciliationRequiredError,
    );
    await executor.reconcileStartup();
    expect(trader.reconciliations).toEqual([{ clientOrderId: "intent-1" }]);
    expect(restarted.getOrder("intent-1")?.status).toBe("cancelled");
    await expect(executor.execute(request({ id: "intent-2" }))).resolves.toEqual({
      intentId: "intent-2",
      status: "cancelled",
      reason: "dry_run",
    });
    expect(trader.submissions).toHaveLength(0);
    restarted.close();
  });

  it("blocks submissions at the serialized boundary while halted", async () => {
    const store = createStore();
    const trader = new TraderStub();
    const executor = new SerializedExecutor(store, trader, options, {
      now: () => timestamp + 2,
    });
    await executor.reconcileStartup();
    executor.halt();

    await expect(executor.execute(request())).resolves.toEqual({
      intentId: "intent-1",
      status: "failed",
      reason: "execution is halted",
    });
    expect(trader.submissions).toEqual([]);

    executor.resume();
    await executor.execute(request());
    expect(trader.submissions).toHaveLength(1);
    store.close();
  });
});

describe("roundPriceDown", () => {
  it("never rounds a maximum price up", () => {
    expect(roundPriceDown(0.987, 0.01)).toBe(0.98);
    expect(roundPriceDown(0.99, 0.01)).toBe(0.99);
    expect(roundPriceDown(0.079, 0.005)).toBe(0.075);
    expect(roundPriceDown(0.3, 0.1)).toBe(0.3);
  });
});
