import type { PriceLevel, TermSpec } from "../domain/types.js";

export interface FeeSchedule {
  readonly rate: number;
  readonly exponent: number;
}

export interface MarketTokens {
  readonly yes: string;
  readonly no: string;
}

export interface SelectedMarket {
  readonly id: string;
  readonly question: string;
  readonly description: string;
  readonly term: TermSpec;
  readonly tokens: MarketTokens;
  readonly tickSize: number;
  readonly minimumOrderSize: number;
  readonly feeSchedule: FeeSchedule | undefined;
  readonly negRisk: boolean;
  readonly acceptingOrders: boolean;
}

export interface EventMarkets {
  readonly eventId: string;
  readonly title: string;
  readonly rulesHash: string;
  readonly markets: readonly SelectedMarket[];
}

export interface BookState {
  readonly tokenId: string;
  readonly bids: readonly PriceLevel[];
  readonly asks: readonly PriceLevel[];
  readonly tickSize: number;
  readonly sourceTimestampMs: number | undefined;
  readonly receivedAtMs: number;
  readonly synchronized: boolean;
}

export interface BookSnapshotInput {
  readonly tokenId: string;
  readonly bids: readonly PriceLevel[];
  readonly asks: readonly PriceLevel[];
  readonly tickSize: number;
  readonly sourceTimestampMs?: number;
  readonly receivedAtMs: number;
}

export interface BookDelta {
  readonly tokenId: string;
  readonly side: "BUY" | "SELL";
  readonly price: number;
  readonly size: number;
  readonly sourceTimestampMs?: number;
  readonly receivedAtMs: number;
}

export interface TickSizeChange {
  readonly tokenId: string;
  readonly tickSize: number;
  readonly sourceTimestampMs?: number;
  readonly receivedAtMs: number;
}

export interface BuyExecutionEstimate {
  readonly requestedShares: number;
  readonly filledShares: number;
  readonly unfilledShares: number;
  readonly grossCost: number;
  readonly fee: number;
  readonly totalCost: number;
  readonly averagePrice: number | undefined;
  readonly averageCostPerShare: number | undefined;
  readonly complete: boolean;
}
