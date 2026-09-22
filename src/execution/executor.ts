import type { Clock } from "../core/clock.js";
import { systemClock } from "../core/clock.js";
import { withTimeout } from "../core/async.js";
import type {
  ExecutionRequest,
  ExecutionResult,
  FillRecord,
  OrderIntentStatus,
} from "../domain/types.js";
import type { BudgetLimits, SqliteStore, StoredOrder } from "../storage/store.js";

export interface FakMarketBuy {
  readonly clientOrderId: string;
  readonly tokenId: string;
  readonly notional: number;
  readonly maxPrice: number;
  readonly side: "BUY";
  readonly timeInForce: "FAK";
}

export type VenueOrderStatus =
  | "submitted"
  | "unknown"
  | "partially_filled"
  | "filled"
  | "cancelled"
  | "rejected"
  | "not_found";

export interface VenueOrderResult {
  readonly status: VenueOrderStatus;
  readonly venueOrderId?: string;
  readonly reason?: string;
  readonly fills?: readonly FillRecord[];
}

export interface VenueOrderReference {
  readonly clientOrderId: string;
  readonly venueOrderId?: string;
}

export interface VenueTrader {
  availableBalance(signal: AbortSignal): Promise<number>;
  submitFakMarketBuy(order: FakMarketBuy, signal: AbortSignal): Promise<VenueOrderResult>;
  reconcileOrder(reference: VenueOrderReference, signal: AbortSignal): Promise<VenueOrderResult>;
}

export interface ExecutorLimits {
  readonly dailyNotionalLimit: number;
  readonly eventNotionalLimit: number;
  readonly forecastMarketAllowance: number;
  readonly sniperMarketAllowance: number;
  readonly maximumSourceAgeMs: number;
}

export interface ExecutorOptions {
  readonly liveTrading: boolean;
  readonly requestTimeoutMs: number;
  readonly limits: ExecutorLimits;
}

export class ReconciliationRequiredError extends Error {
  public constructor(public readonly unresolvedCount: number) {
    super(
      unresolvedCount === 0
        ? "startup reconciliation has not completed"
        : `${unresolvedCount} order(s) still require reconciliation`,
    );
    this.name = "ReconciliationRequiredError";
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "venue operation failed";
}

export function roundPriceDown(price: number, tickSize: number): number {
  if (!Number.isFinite(price) || price <= 0 || price > 1) {
    throw new RangeError("price must be in (0, 1]");
  }
  if (!Number.isFinite(tickSize) || tickSize <= 0 || tickSize > 1) {
    throw new RangeError("tick size must be in (0, 1]");
  }
  const tickText = tickSize.toString().toLowerCase();
  const [mantissa = tickText, exponentText] = tickText.split("e");
  const exponent = exponentText === undefined ? 0 : Number(exponentText);
  const fractionLength = mantissa.split(".")[1]?.length ?? 0;
  const precision = Math.min(12, Math.max(0, fractionLength - exponent));
  const scale = 10 ** precision;
  const tickUnits = Math.round(tickSize * scale);
  const ticks = Math.floor((price * scale + 1e-9) / tickUnits);
  const rounded = (ticks * tickUnits) / scale;
  if (rounded <= 0) throw new RangeError("price is below one tick");
  return rounded;
}

function toIntentStatus(status: VenueOrderStatus): OrderIntentStatus {
  switch (status) {
    case "submitted":
      return "submitted";
    case "unknown":
      return "unknown";
    case "partially_filled":
      return "partially_filled";
    case "filled":
      return "filled";
    case "cancelled":
    case "not_found":
      return "cancelled";
    case "rejected":
      return "failed";
  }
}

export class SerializedExecutor {
  private ready = false;
  private halted = false;
  private serialTail: Promise<void> = Promise.resolve();

  public constructor(
    private readonly store: SqliteStore,
    private readonly trader: VenueTrader,
    private readonly options: ExecutorOptions,
    private readonly clock: Clock = systemClock,
  ) {}

  public reconcileStartup(): Promise<void> {
    return this.runSerialized(async () => {
      this.ready = false;
      await this.reconcileOrders(this.store.listUnresolvedOrders());
      const unresolved = this.store.listUnresolvedOrders();
      if (unresolved.length > 0) {
        throw new ReconciliationRequiredError(unresolved.length);
      }
      this.ready = true;
    });
  }

  public reconcile(): Promise<void> {
    return this.reconcileStartup();
  }

  public halt(): void {
    this.halted = true;
  }

  public resume(): void {
    if (!this.ready) {
      throw new ReconciliationRequiredError(this.store.listUnresolvedOrders().length);
    }
    this.halted = false;
  }

  public execute(request: ExecutionRequest): Promise<ExecutionResult> {
    return this.runSerialized(async () => {
      if (!this.ready) throw new ReconciliationRequiredError(this.store.listUnresolvedOrders().length);
      if (this.halted) {
        return {
          intentId: request.intent.id,
          status: "failed",
          reason: "execution is halted",
        };
      }

      const rejection = this.validateRequest(request);
      if (rejection !== undefined) {
        return { intentId: request.intent.id, status: "failed", reason: rejection };
      }

      const maxPrice = roundPriceDown(request.intent.maxPrice, request.market.tickSize);
      const intent = Object.freeze({ ...request.intent, maxPrice });
      const minimumNotional = request.market.minimumOrderSize * maxPrice;
      if (intent.notional < minimumNotional) {
        return {
          intentId: intent.id,
          status: "failed",
          reason: "order is below the venue minimum size",
        };
      }

      let availableBalance = Number.MAX_SAFE_INTEGER;
      if (this.options.liveTrading) {
        try {
          availableBalance = await withTimeout(
            (signal) => this.trader.availableBalance(signal),
            this.options.requestTimeoutMs,
            "balance check",
          );
        } catch (error) {
          return { intentId: intent.id, status: "failed", reason: errorMessage(error) };
        }
        if (!Number.isFinite(availableBalance) || availableBalance < 0) {
          return { intentId: intent.id, status: "failed", reason: "invalid venue balance" };
        }
      }

      const budgetLimits: BudgetLimits = {
        daily: this.options.limits.dailyNotionalLimit,
        event: this.options.limits.eventNotionalLimit,
        strategyMarket:
          intent.strategy === "sniper"
            ? this.options.limits.sniperMarketAllowance
            : this.options.limits.forecastMarketAllowance,
        walletAvailable: availableBalance,
      };
      const reservation = this.store.reserveOrder(
        intent,
        intent.notional * request.market.feeRate,
        budgetLimits,
      );
      if (!reservation.accepted) {
        return {
          intentId: intent.id,
          status: "failed",
          reason: reservation.reason ?? "budget reservation failed",
        };
      }

      if (!this.options.liveTrading) {
        this.store.recordOrderEvent(intent.id, "cancelled", this.clock.now(), {
          reason: "dry_run",
        });
        return { intentId: intent.id, status: "cancelled", reason: "dry_run" };
      }

      try {
        const result = await withTimeout(
          (signal) =>
            this.trader.submitFakMarketBuy(
              {
                clientOrderId: intent.id,
                tokenId: intent.tokenId,
                notional: intent.notional,
                maxPrice,
                side: "BUY",
                timeInForce: "FAK",
              },
              signal,
            ),
          this.options.requestTimeoutMs,
          "order submission",
        );
        return this.persistVenueResult(intent.id, result);
      } catch (error) {
        const reason = errorMessage(error);
        this.store.recordOrderEvent(intent.id, "unknown", this.clock.now(), { reason });
        this.ready = false;
        return { intentId: intent.id, status: "unknown", reason };
      }
    });
  }

  private validateRequest(request: ExecutionRequest): string | undefined {
    if (!request.market.acceptingOrders) return "market is not accepting orders";
    if (!request.book.synchronized) return "order book is not synchronized";
    if (
      !Number.isFinite(request.observedAgeMs) ||
      request.observedAgeMs < 0 ||
      request.observedAgeMs > this.options.limits.maximumSourceAgeMs
    ) {
      return "observed audio data is stale";
    }
    if (request.intent.marketId !== request.market.marketId) return "intent market mismatch";
    if (request.intent.eventId !== request.market.eventId) return "intent event mismatch";
    if (request.intent.tokenId !== request.book.tokenId) return "intent token mismatch";
    if (request.book.tickSize !== request.market.tickSize) return "book tick size is stale";
    return undefined;
  }

  private async reconcileOrders(orders: readonly StoredOrder[]): Promise<void> {
    for (const order of orders) {
      let result: VenueOrderResult;
      try {
        result = await withTimeout(
          (signal) =>
            this.trader.reconcileOrder(
              {
                clientOrderId: order.intent.id,
                ...(order.venueOrderId === undefined
                  ? {}
                  : { venueOrderId: order.venueOrderId }),
              },
              signal,
            ),
          this.options.requestTimeoutMs,
          `reconcile order ${order.intent.id}`,
        );
      } catch {
        // The existing durable state remains authoritative until the venue can answer.
        continue;
      }
      this.persistVenueResult(order.intent.id, result);
    }
  }

  private persistVenueResult(intentId: string, result: VenueOrderResult): ExecutionResult {
    const occurredAtMs = this.clock.now();
    for (const fill of result.fills ?? []) {
      if (fill.intentId !== intentId) {
        throw new Error(`venue returned a fill for the wrong intent: ${fill.intentId}`);
      }
      this.store.ingestFill(fill, occurredAtMs);
    }
    const status = toIntentStatus(result.status);
    this.store.recordOrderEvent(intentId, status, occurredAtMs, {
      ...(result.venueOrderId === undefined ? {} : { venueOrderId: result.venueOrderId }),
      ...(result.reason === undefined ? {} : { reason: result.reason }),
    });
    if (status === "submitted" || status === "unknown") this.ready = false;
    return {
      intentId,
      status,
      ...(result.venueOrderId === undefined ? {} : { venueOrderId: result.venueOrderId }),
      ...(result.reason === undefined ? {} : { reason: result.reason }),
    };
  }

  private async runSerialized<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.serialTail;
    let release: (() => void) | undefined;
    this.serialTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await operation();
    } finally {
      release?.();
    }
  }
}
