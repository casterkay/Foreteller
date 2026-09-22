import type { Limits } from "../config.js";
import type {
  BookSnapshot,
  ForecastAnswer,
  MarketDefinition,
  MentionHit,
} from "../domain/types.js";
import { roundPriceDown } from "../execution/executor.js";
import { estimateBuyExecution, takerFee } from "../market/execution-cost.js";
import type { BookState, BuyExecutionEstimate, FeeSchedule } from "../market/types.js";

export type DecisionRejectionReason =
  | "market_closed"
  | "book_token_mismatch"
  | "book_tick_size_mismatch"
  | "book_unsynchronized"
  | "book_stale"
  | "empty_ask_book"
  | "cooldown"
  | "attempt_limit"
  | "allowance_exhausted"
  | "forecast_stale"
  | "market_already_matched"
  | "mention_market_mismatch"
  | "forecast_probability_invalid"
  | "ask_outside_forecast_range"
  | "no_price_with_required_edge"
  | "insufficient_depth"
  | "below_minimum_order_size";

export interface AcceptedDecision {
  readonly accepted: true;
  readonly strategy: "sniper" | "forecast";
  readonly marketId: string;
  readonly tokenId: string;
  readonly notional: number;
  readonly requestedShares: number;
  readonly maxPrice: number;
  readonly estimate: BuyExecutionEstimate;
}

export interface RejectedDecision {
  readonly accepted: false;
  readonly strategy: "sniper" | "forecast";
  readonly marketId: string;
  readonly reason: DecisionRejectionReason;
}

export type StrategyDecision = AcceptedDecision | RejectedDecision;

interface SharedDecisionInput {
  readonly market: MarketDefinition;
  readonly book: BookSnapshot;
  readonly nowMs: number;
  readonly remainingAllowance: number;
}

export interface SniperDecisionInput extends SharedDecisionInput {
  readonly mention: MentionHit;
  readonly attempts: number;
  readonly lastAttemptAtMs: number | undefined;
  readonly limits: Pick<
    Limits,
    | "maximumSourceAgeMs"
    | "sniperCooldownMs"
    | "sniperMaximumAttempts"
    | "sniperMarketAllowance"
    | "sniperPriceCap"
    | "sniperSlippage"
  >;
}

export interface ForecastDecisionInput extends SharedDecisionInput {
  readonly forecast: ForecastAnswer;
  readonly feeSchedule: FeeSchedule | undefined;
  readonly marketAlreadyMatched: boolean;
  readonly lastAttemptAtMs: number | undefined;
  readonly limits: Pick<
    Limits,
    | "maximumSourceAgeMs"
    | "maximumForecastAgeMs"
    | "forecastNotional"
    | "forecastMarketAllowance"
    | "forecastMinimumEdge"
    | "forecastPriceFloor"
    | "forecastPriceCeiling"
    | "forecastCooldownMs"
  >;
}

export function decideSniperOrder(input: SniperDecisionInput): StrategyDecision {
  const rejection = validateSharedInput(input, "sniper", input.limits.maximumSourceAgeMs);
  if (rejection !== undefined) return rejection;
  if (input.mention.marketId !== input.market.marketId) {
    return reject("sniper", input.market.marketId, "mention_market_mismatch");
  }
  if (input.attempts >= input.limits.sniperMaximumAttempts) {
    return reject("sniper", input.market.marketId, "attempt_limit");
  }
  if (inCooldown(input.nowMs, input.lastAttemptAtMs, input.limits.sniperCooldownMs)) {
    return reject("sniper", input.market.marketId, "cooldown");
  }

  const availableNotional = Math.min(input.remainingAllowance, input.limits.sniperMarketAllowance);
  if (!(availableNotional > 0)) return reject("sniper", input.market.marketId, "allowance_exhausted");

  const bestAsk = input.book.asks[0];
  if (bestAsk === undefined) return reject("sniper", input.market.marketId, "empty_ask_book");
  const maxPrice = boundedSniperPrice(bestAsk.price, input.market.tickSize, input.limits);
  if (maxPrice === undefined) {
    return reject("sniper", input.market.marketId, "no_price_with_required_edge");
  }

  const estimate = estimateNotionalDepth(input.book, maxPrice, availableNotional, undefined);
  if (estimate === undefined) return reject("sniper", input.market.marketId, "insufficient_depth");
  if (estimate.filledShares < input.market.minimumOrderSize) {
    return reject("sniper", input.market.marketId, "below_minimum_order_size");
  }
  return accept("sniper", input.market, estimate, maxPrice);
}

export function decideForecastOrder(input: ForecastDecisionInput): StrategyDecision {
  const rejection = validateSharedInput(input, "forecast", input.limits.maximumSourceAgeMs);
  if (rejection !== undefined) return rejection;
  if (input.marketAlreadyMatched) return reject("forecast", input.market.marketId, "market_already_matched");
  if (!Number.isFinite(input.forecast.probability) || input.forecast.probability < 0 || input.forecast.probability > 1) {
    return reject("forecast", input.market.marketId, "forecast_probability_invalid");
  }
  if (
    !Number.isFinite(input.forecast.snapshotAtMs) ||
    input.forecast.snapshotAtMs > input.nowMs ||
    input.nowMs - input.forecast.snapshotAtMs > input.limits.maximumForecastAgeMs
  ) {
    return reject("forecast", input.market.marketId, "forecast_stale");
  }
  if (inCooldown(input.nowMs, input.lastAttemptAtMs, input.limits.forecastCooldownMs)) {
    return reject("forecast", input.market.marketId, "cooldown");
  }

  const availableNotional = Math.min(
    input.remainingAllowance,
    input.limits.forecastMarketAllowance,
    input.limits.forecastNotional,
  );
  if (!(availableNotional > 0)) return reject("forecast", input.market.marketId, "allowance_exhausted");

  const bestAsk = input.book.asks[0];
  if (bestAsk === undefined) return reject("forecast", input.market.marketId, "empty_ask_book");
  if (bestAsk.price < input.limits.forecastPriceFloor || bestAsk.price > input.limits.forecastPriceCeiling) {
    return reject("forecast", input.market.marketId, "ask_outside_forecast_range");
  }

  const maxPrice = forecastMaximumPrice(input.forecast.probability, input.market.tickSize, input.limits, input.feeSchedule);
  if (maxPrice === undefined || maxPrice < bestAsk.price) {
    return reject("forecast", input.market.marketId, "no_price_with_required_edge");
  }
  const estimate = estimateNotionalDepth(input.book, maxPrice, availableNotional, input.feeSchedule);
  if (estimate === undefined || !estimate.complete) {
    return reject("forecast", input.market.marketId, "insufficient_depth");
  }
  if (estimate.filledShares < input.market.minimumOrderSize) {
    return reject("forecast", input.market.marketId, "below_minimum_order_size");
  }
  if (
    estimate.averageCostPerShare === undefined ||
    input.forecast.probability - estimate.averageCostPerShare < input.limits.forecastMinimumEdge
  ) {
    return reject("forecast", input.market.marketId, "no_price_with_required_edge");
  }
  return accept("forecast", input.market, estimate, maxPrice);
}

function validateSharedInput(
  input: SharedDecisionInput,
  strategy: "sniper" | "forecast",
  maximumBookAgeMs: number,
): RejectedDecision | undefined {
  if (!input.market.acceptingOrders) return reject(strategy, input.market.marketId, "market_closed");
  if (input.book.tokenId !== input.market.yesTokenId) return reject(strategy, input.market.marketId, "book_token_mismatch");
  if (input.book.tickSize !== input.market.tickSize) return reject(strategy, input.market.marketId, "book_tick_size_mismatch");
  if (!input.book.synchronized) return reject(strategy, input.market.marketId, "book_unsynchronized");
  if (!Number.isFinite(input.nowMs) || input.nowMs < input.book.receivedAtMs || input.nowMs - input.book.receivedAtMs > maximumBookAgeMs) {
    return reject(strategy, input.market.marketId, "book_stale");
  }
  return undefined;
}

function boundedSniperPrice(
  bestAsk: number,
  tickSize: number,
  limits: SniperDecisionInput["limits"],
): number | undefined {
  const cap = Math.min(limits.sniperPriceCap, bestAsk + limits.sniperSlippage);
  return safeRoundPriceDown(cap, tickSize);
}

function forecastMaximumPrice(
  probability: number,
  tickSize: number,
  limits: ForecastDecisionInput["limits"],
  feeSchedule: FeeSchedule | undefined,
): number | undefined {
  const unroundedCap = Math.min(limits.forecastPriceCeiling, probability - limits.forecastMinimumEdge);
  let maxPrice = safeRoundPriceDown(unroundedCap, tickSize);
  if (maxPrice === undefined) return undefined;
  // A FAK can fill at any price up to maxPrice. Its fee must also preserve the edge.
  while (maxPrice > 0 && probability - maxPrice - takerFee(maxPrice, 1, feeSchedule) < limits.forecastMinimumEdge) {
    maxPrice = safeRoundPriceDown(maxPrice - tickSize, tickSize);
    if (maxPrice === undefined) return undefined;
  }
  return maxPrice;
}

function safeRoundPriceDown(price: number, tickSize: number): number | undefined {
  if (
    !Number.isFinite(price) ||
    price <= 0 ||
    price > 1 ||
    !Number.isFinite(tickSize) ||
    tickSize <= 0 ||
    tickSize > 1
  ) {
    return undefined;
  }
  return roundPriceDown(price, tickSize);
}

function estimateNotionalDepth(
  snapshot: BookSnapshot,
  maxPrice: number,
  budget: number,
  feeSchedule: FeeSchedule | undefined,
): BuyExecutionEstimate | undefined {
  const eligibleAsks = snapshot.asks.filter((level) => level.price <= maxPrice && level.size > 0);
  const maximumShares = eligibleAsks.reduce((total, level) => total + level.size, 0);
  if (!(maximumShares > 0)) return undefined;
  const book: BookState = {
    tokenId: snapshot.tokenId,
    bids: snapshot.bids,
    asks: eligibleAsks,
    tickSize: snapshot.tickSize,
    sourceTimestampMs: undefined,
    receivedAtMs: snapshot.receivedAtMs,
    synchronized: true,
  };
  const allDepth = estimateBuyExecution(book, maximumShares, feeSchedule);
  if (allDepth.totalCost <= budget) return allDepth;

  // Costs are monotonic in requested shares. Six decimals is substantially finer
  // than venue minimum sizes while keeping the resulting order reproducible.
  let low = 0;
  let high = maximumShares;
  for (let iteration = 0; iteration < 60; iteration += 1) {
    const midpoint = (low + high) / 2;
    const estimate = estimateBuyExecution(book, midpoint, feeSchedule);
    if (estimate.complete && estimate.totalCost <= budget) low = midpoint;
    else high = midpoint;
  }
  const shares = Math.floor(low * 1_000_000) / 1_000_000;
  return shares > 0 ? estimateBuyExecution(book, shares, feeSchedule) : undefined;
}

function accept(
  strategy: "sniper" | "forecast",
  market: MarketDefinition,
  estimate: BuyExecutionEstimate,
  maxPrice: number,
): AcceptedDecision {
  return Object.freeze({
    accepted: true,
    strategy,
    marketId: market.marketId,
    tokenId: market.yesTokenId,
    notional: estimate.grossCost,
    requestedShares: estimate.requestedShares,
    maxPrice,
    estimate,
  });
}

function reject(
  strategy: "sniper" | "forecast",
  marketId: string,
  reason: DecisionRejectionReason,
): RejectedDecision {
  return Object.freeze({ accepted: false, strategy, marketId, reason });
}

function inCooldown(nowMs: number, lastAttemptAtMs: number | undefined, cooldownMs: number): boolean {
  return lastAttemptAtMs !== undefined && nowMs - lastAttemptAtMs < cooldownMs;
}
