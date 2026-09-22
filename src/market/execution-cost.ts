import type { BookState, BuyExecutionEstimate, FeeSchedule } from "./types.js";

export function estimateBuyExecution(
  book: BookState,
  requestedShares: number,
  feeSchedule: FeeSchedule | undefined,
): BuyExecutionEstimate {
  if (!book.synchronized) throw new Error("Cannot price an unsynchronized book");
  if (!Number.isFinite(requestedShares) || requestedShares <= 0) {
    throw new Error(`Requested shares must be positive: ${requestedShares}`);
  }

  let remaining = requestedShares;
  let grossCost = 0;
  let fee = 0;

  for (const level of book.asks) {
    if (remaining <= 0) break;
    const shares = Math.min(remaining, level.size);
    grossCost += level.price * shares;
    fee += takerFee(level.price, shares, feeSchedule);
    remaining -= shares;
  }

  const filledShares = requestedShares - remaining;
  const totalCost = grossCost + fee;
  if (filledShares === 0) {
    return Object.freeze({
      requestedShares,
      filledShares,
      unfilledShares: remaining,
      grossCost,
      fee,
      totalCost,
      averagePrice: undefined,
      averageCostPerShare: undefined,
      complete: false,
    });
  }
  return Object.freeze({
    requestedShares,
    filledShares,
    unfilledShares: remaining,
    grossCost,
    fee,
    totalCost,
    averagePrice: grossCost / filledShares,
    averageCostPerShare: totalCost / filledShares,
    complete: remaining === 0,
  });
}

export function takerFee(
  price: number,
  shares: number,
  feeSchedule: FeeSchedule | undefined,
): number {
  if (feeSchedule === undefined) return 0;
  if (!Number.isFinite(price) || price <= 0 || price >= 1) {
    throw new Error(`Invalid fee price: ${price}`);
  }
  if (!Number.isFinite(shares) || shares < 0) {
    throw new Error(`Invalid fee shares: ${shares}`);
  }
  if (
    !Number.isFinite(feeSchedule.rate) ||
    feeSchedule.rate < 0 ||
    !Number.isFinite(feeSchedule.exponent) ||
    feeSchedule.exponent < 0
  ) {
    throw new Error("Invalid fee schedule");
  }

  // Polymarket's taker-fee curve is rate * (p * (1 - p))^exponent per share.
  return feeSchedule.rate * (price * (1 - price)) ** feeSchedule.exponent * shares;
}
