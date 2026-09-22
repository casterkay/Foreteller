import type { BookDelta, BookSnapshotInput, BookState, TickSizeChange } from "./types.js";

const minimumPrice = 0;
const maximumPrice = 1;

export function emptyBook(
  tokenId: string,
  tickSize: number,
  receivedAtMs: number,
): BookState {
  validateTickSize(tickSize);
  return freezeBook({
    tokenId: validateTokenId(tokenId),
    bids: [],
    asks: [],
    tickSize,
    sourceTimestampMs: undefined,
    receivedAtMs: validateTimestamp(receivedAtMs),
    synchronized: false,
  });
}

export function applyBookSnapshot(input: BookSnapshotInput): BookState {
  validateTickSize(input.tickSize);
  const tokenId = validateTokenId(input.tokenId);
  const sourceTimestampMs = optionalTimestamp(input.sourceTimestampMs);
  const receivedAtMs = validateTimestamp(input.receivedAtMs);

  return freezeBook({
    tokenId,
    bids: normalizeLevels(input.bids, "BUY", input.tickSize),
    asks: normalizeLevels(input.asks, "SELL", input.tickSize),
    tickSize: input.tickSize,
    sourceTimestampMs,
    receivedAtMs,
    synchronized: true,
  });
}

export function applyBookDelta(state: BookState, delta: BookDelta): BookState {
  assertSameToken(state.tokenId, delta.tokenId);
  validateLevel(delta.price, delta.size, state.tickSize);
  if (isOlderThanBook(state, delta.sourceTimestampMs)) {
    return markBookUnsynchronized(state, delta.receivedAtMs);
  }

  if (!state.synchronized) {
    return freezeBook({
      ...state,
      receivedAtMs: validateTimestamp(delta.receivedAtMs),
      sourceTimestampMs: newestTimestamp(state.sourceTimestampMs, delta.sourceTimestampMs),
    });
  }

  const levels = delta.side === "BUY" ? state.bids : state.asks;
  const replacement = replaceLevel(levels, delta.price, delta.size, delta.side);

  return freezeBook({
    ...state,
    ...(delta.side === "BUY" ? { bids: replacement } : { asks: replacement }),
    receivedAtMs: validateTimestamp(delta.receivedAtMs),
    sourceTimestampMs: newestTimestamp(state.sourceTimestampMs, delta.sourceTimestampMs),
  });
}

export function applyTickSizeChange(
  state: BookState,
  change: TickSizeChange,
): BookState {
  assertSameToken(state.tokenId, change.tokenId);
  validateTickSize(change.tickSize);
  if (isOlderThanBook(state, change.sourceTimestampMs)) {
    return markBookUnsynchronized(state, change.receivedAtMs);
  }

  // Existing levels may not be legal at the new increment. A fresh book is the
  // only authoritative way to resume execution after a tick-size transition.
  return freezeBook({
    ...state,
    tickSize: change.tickSize,
    receivedAtMs: validateTimestamp(change.receivedAtMs),
    sourceTimestampMs: newestTimestamp(state.sourceTimestampMs, change.sourceTimestampMs),
    synchronized: false,
  });
}

export function markBookUnsynchronized(state: BookState, receivedAtMs: number): BookState {
  return freezeBook({
    ...state,
    receivedAtMs: validateTimestamp(receivedAtMs),
    synchronized: false,
  });
}

export function isBookUsable(
  state: BookState,
  maximumAgeMs: number,
  nowMs: number,
): boolean {
  if (!state.synchronized || !Number.isFinite(maximumAgeMs) || maximumAgeMs < 0) {
    return false;
  }
  const sourceAtMs = state.sourceTimestampMs ?? state.receivedAtMs;
  return nowMs >= sourceAtMs && nowMs - sourceAtMs <= maximumAgeMs;
}

function normalizeLevels(
  levels: readonly { readonly price: number; readonly size: number }[],
  side: "BUY" | "SELL",
  tickSize: number,
): readonly { readonly price: number; readonly size: number }[] {
  const byPrice = new Map<number, number>();
  for (const level of levels) {
    validateLevel(level.price, level.size, tickSize);
    if (level.size > 0) byPrice.set(level.price, level.size);
  }
  return sortLevels(byPrice, side);
}

function replaceLevel(
  levels: readonly { readonly price: number; readonly size: number }[],
  price: number,
  size: number,
  side: "BUY" | "SELL",
): readonly { readonly price: number; readonly size: number }[] {
  const byPrice = new Map(levels.map((level) => [level.price, level.size]));
  if (size === 0) byPrice.delete(price);
  else byPrice.set(price, size);
  return sortLevels(byPrice, side);
}

function sortLevels(
  levels: ReadonlyMap<number, number>,
  side: "BUY" | "SELL",
): readonly { readonly price: number; readonly size: number }[] {
  const sorted = [...levels.entries()]
    .sort(([left], [right]) => (side === "BUY" ? right - left : left - right))
    .map(([price, size]) => Object.freeze({ price, size }));
  return Object.freeze(sorted);
}

function freezeBook(state: BookState): BookState {
  return Object.freeze({
    ...state,
    bids: Object.freeze([...state.bids]),
    asks: Object.freeze([...state.asks]),
  });
}

function validateLevel(price: number, size: number, tickSize: number): void {
  if (!Number.isFinite(price) || price <= minimumPrice || price >= maximumPrice) {
    throw new Error(`Invalid book price: ${price}`);
  }
  if (!Number.isFinite(size) || size < 0) throw new Error(`Invalid book size: ${size}`);
  if (!isOnTick(price, tickSize)) {
    throw new Error(`Price ${price} is not aligned to tick size ${tickSize}`);
  }
}

function validateTickSize(tickSize: number): void {
  if (!Number.isFinite(tickSize) || tickSize <= 0 || tickSize > 1) {
    throw new Error(`Invalid tick size: ${tickSize}`);
  }
}

function isOnTick(price: number, tickSize: number): boolean {
  return Math.abs(price / tickSize - Math.round(price / tickSize)) < 1e-9;
}

function validateTokenId(tokenId: string): string {
  if (tokenId.trim().length === 0) throw new Error("Book token ID is required");
  return tokenId;
}

function validateTimestamp(timestamp: number): number {
  if (!Number.isFinite(timestamp) || timestamp < 0) {
    throw new Error(`Invalid timestamp: ${timestamp}`);
  }
  return timestamp;
}

function optionalTimestamp(timestamp: number | undefined): number | undefined {
  return timestamp === undefined ? undefined : validateTimestamp(timestamp);
}

function newestTimestamp(
  current: number | undefined,
  candidate: number | undefined,
): number | undefined {
  const validCandidate = optionalTimestamp(candidate);
  if (current === undefined) return validCandidate;
  if (validCandidate === undefined) return current;
  return Math.max(current, validCandidate);
}

function isOlderThanBook(state: BookState, sourceTimestampMs: number | undefined): boolean {
  const candidate = optionalTimestamp(sourceTimestampMs);
  return candidate !== undefined && state.sourceTimestampMs !== undefined && candidate < state.sourceTimestampMs;
}

function assertSameToken(expected: string, actual: string): void {
  if (expected !== actual) {
    throw new Error(`Book token mismatch: expected ${expected}, received ${actual}`);
  }
}
