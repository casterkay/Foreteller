export type SessionStatus =
  | "draft"
  | "waiting"
  | "live"
  | "halted"
  | "ended";

export type Strategy = "sniper" | "forecast";

export interface TermSpec {
  readonly marketId: string;
  readonly label: string;
  readonly acceptedForms: readonly string[];
  readonly excludedForms: readonly string[];
  readonly speakerScope: "anyone" | "primary";
  readonly windowStartMs: number;
  readonly windowEndMs: number;
}

export interface MarketDefinition {
  readonly eventId: string;
  readonly marketId: string;
  readonly question: string;
  readonly description: string;
  readonly yesTokenId: string;
  readonly noTokenId: string;
  readonly tickSize: number;
  readonly minimumOrderSize: number;
  readonly negRisk: boolean;
  readonly acceptingOrders: boolean;
  readonly feeRate: number;
  readonly term: TermSpec;
}

export interface SessionBinding {
  readonly sessionId: string;
  readonly eventId: string;
  readonly eventTitle: string;
  readonly rulesHash: string;
  readonly videoUrl: string;
  readonly videoId: string;
  readonly channelId: string;
  readonly speaker: string;
  readonly expectedStartMs: number;
  readonly expectedEndMs: number;
  readonly markets: readonly MarketDefinition[];
  readonly confirmedAtMs: number;
}

export interface PriceLevel {
  readonly price: number;
  readonly size: number;
}

export interface BookSnapshot {
  readonly tokenId: string;
  readonly bids: readonly PriceLevel[];
  readonly asks: readonly PriceLevel[];
  readonly tickSize: number;
  readonly receivedAtMs: number;
  readonly synchronized: boolean;
}

export interface TranscriptWord {
  readonly text: string;
  readonly startMs: number;
  readonly endMs: number;
  readonly confidence: number;
  readonly speaker?: number;
}

export interface TranscriptSegment {
  readonly id: string;
  readonly text: string;
  readonly words: readonly TranscriptWord[];
  readonly sourceStartMs: number;
  readonly sourceEndMs: number;
  readonly receivedAtMs: number;
  readonly isFinal: boolean;
}

export interface MentionHit {
  readonly marketId: string;
  readonly term: string;
  readonly transcript: string;
  readonly sourceStartMs: number;
  readonly sourceEndMs: number;
  readonly minimumConfidence: number;
  readonly segmentIds: readonly string[];
}

export interface ForecastAnswer {
  readonly marketId: string;
  readonly probability: number;
  readonly model: string;
  readonly snapshotAtMs: number;
  readonly latencyMs: number;
}

export interface OrderIntent {
  readonly id: string;
  readonly sessionId: string;
  readonly eventId: string;
  readonly marketId: string;
  readonly tokenId: string;
  readonly strategy: Strategy;
  readonly notional: number;
  readonly maxPrice: number;
  readonly evidenceJson: string;
  readonly createdAtMs: number;
}

export type OrderIntentStatus =
  | "reserved"
  | "submitted"
  | "unknown"
  | "partially_filled"
  | "filled"
  | "cancelled"
  | "failed";

export interface FillRecord {
  readonly venueTradeId: string;
  readonly venueOrderId: string;
  readonly intentId: string;
  readonly price: number;
  readonly shares: number;
  readonly fee: number;
  readonly status: "matched" | "confirmed" | "failed";
  readonly occurredAtMs: number;
}

export interface ExecutionRequest {
  readonly intent: OrderIntent;
  readonly market: MarketDefinition;
  readonly book: BookSnapshot;
  readonly sourceAgeMs: number;
}

export interface ExecutionResult {
  readonly intentId: string;
  readonly status: OrderIntentStatus;
  readonly venueOrderId?: string;
  readonly reason?: string;
}
