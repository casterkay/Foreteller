import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { FillRecord, OrderIntent } from "../src/domain/types.js";
import { SqliteStore, type BudgetLimits } from "../src/storage/index.js";

const temporaryDirectories: string[] = [];

function databasePath(): string {
  const directory = mkdtempSync(join(tmpdir(), "foreteller-storage-"));
  temporaryDirectories.push(directory);
  return join(directory, "test.sqlite");
}

function intent(overrides: Partial<OrderIntent> = {}): OrderIntent {
  return {
    id: "intent-1",
    sessionId: "session-1",
    eventId: "event-1",
    marketId: "market-1",
    tokenId: "yes-1",
    strategy: "sniper",
    notional: 6,
    maxPrice: 0.99,
    evidenceJson: "{}",
    createdAtMs: Date.UTC(2026, 8, 22, 12),
    ...overrides,
  };
}

const generousLimits: BudgetLimits = {
  daily: 250,
  event: 120,
  strategyMarket: 20,
  walletAvailable: 100,
};

function fill(overrides: Partial<FillRecord> = {}): FillRecord {
  return {
    venueTradeId: "trade-1",
    venueOrderId: "order-1",
    intentId: "intent-1",
    price: 0.5,
    shares: 10,
    fee: 0.1,
    status: "matched",
    occurredAtMs: Date.UTC(2026, 8, 22, 12, 0, 1),
    ...overrides,
  };
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("SqliteStore budget reservations", () => {
  it("counts an existing reservation when two store instances contend for the same cap", () => {
    const path = databasePath();
    const first = new SqliteStore(path);
    first.recordSession("session-1", "live", Date.UTC(2026, 8, 22, 12));
    const second = new SqliteStore(path);

    expect(first.reserveOrder(intent(), 0, { ...generousLimits, event: 10 })).toEqual({
      accepted: true,
    });
    expect(
      second.reserveOrder(intent({ id: "intent-2", notional: 5 }), 0, {
        ...generousLimits,
        event: 10,
      }),
    ).toEqual({ accepted: false, reason: "event_limit" });
    expect(first.exposure({ eventId: "event-1" })).toBe(6);

    second.close();
    first.close();
  });

  it("persists UTC daily reservations across restart", () => {
    const path = databasePath();
    const first = new SqliteStore(path);
    first.recordSession("session-1", "live", Date.UTC(2026, 8, 22, 23, 59));
    expect(first.reserveOrder(intent({ notional: 7 }), 0, generousLimits).accepted).toBe(true);
    first.close();

    const restarted = new SqliteStore(path);
    expect(
      restarted.reserveOrder(intent({ id: "intent-2", notional: 4 }), 0, {
        ...generousLimits,
        daily: 10,
      }),
    ).toEqual({ accepted: false, reason: "daily_limit" });
    expect(
      restarted.reserveOrder(
        intent({
          id: "intent-next-day",
          notional: 4,
          createdAtMs: Date.UTC(2026, 8, 23, 0, 0, 1),
        }),
        0,
        { ...generousLimits, daily: 10 },
      ),
    ).toEqual({ accepted: true });
    restarted.close();
  });

  it("reserves fees against wallet capacity without reducing notional allowances", () => {
    const store = new SqliteStore(databasePath());
    store.recordSession("session-1", "live", Date.UTC(2026, 8, 22, 12));

    expect(
      store.reserveOrder(intent({ notional: 10 }), 0.1, {
        daily: 10,
        event: 10,
        strategyMarket: 10,
        walletAvailable: 10,
      }),
    ).toEqual({ accepted: false, reason: "wallet_limit" });
    expect(
      store.reserveOrder(intent({ notional: 10 }), 0.1, {
        daily: 10,
        event: 10,
        strategyMarket: 10,
        walletAvailable: 10.1,
      }),
    ).toEqual({ accepted: true });
    store.close();
  });

  it("counts a partial fill once across duplicate and status-upgrade events", () => {
    const store = new SqliteStore(databasePath());
    store.recordSession("session-1", "live", Date.UTC(2026, 8, 22, 12));
    expect(store.reserveOrder(intent({ notional: 10 }), 1, generousLimits).accepted).toBe(true);

    expect(store.ingestFill(fill(), Date.UTC(2026, 8, 22, 12, 0, 2))).toBe(true);
    expect(store.ingestFill(fill(), Date.UTC(2026, 8, 22, 12, 0, 3))).toBe(false);
    expect(
      store.ingestFill(
        fill({ status: "confirmed" }),
        Date.UTC(2026, 8, 22, 12, 0, 4),
      ),
    ).toBe(true);
    store.recordOrderEvent("intent-1", "partially_filled", Date.UTC(2026, 8, 22, 12, 0, 5));

    expect(store.exposure({ eventId: "event-1" })).toBe(5);
    expect(() =>
      store.ingestFill(fill({ shares: 11 }), Date.UTC(2026, 8, 22, 12, 0, 6)),
    ).toThrow("conflicting fill facts");
    store.close();
  });
});
