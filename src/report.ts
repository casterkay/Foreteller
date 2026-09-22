import type { Strategy } from "./domain/types.js";
import type { SqliteStore, StoredSessionFacts } from "./storage/index.js";
import { TranscriptMatcher } from "./transcript/index.js";

interface StrategySummary {
  readonly decisions: number;
  readonly accepted: number;
  readonly orders: number;
  readonly fills: number;
  readonly spend: number;
  readonly fees: number;
}

export function formatSessionReport(store: SqliteStore, requestedSessionId?: string): string {
  const facts = loadFacts(store, requestedSessionId);
  const lines = [
    `Session: ${facts.sessionId}`,
    `Event: ${facts.binding.eventTitle}`,
    `Status: ${facts.status}`,
    `Reconciliation: ${facts.orders.some((order) => order.status === "unknown") ? "required" : "clear"}`,
    strategyLine("sniper", summarize(facts, "sniper")),
    strategyLine("forecast", summarize(facts, "forecast")),
    `Transcripts: ${String(facts.transcripts.length)}`,
    `Forecasts: ${String(facts.forecasts.length)}`,
    `Execution errors: ${String(facts.orders.filter((order) => order.status === "failed" || order.status === "unknown").length)}`,
    `Unresolved position cost: $${unresolvedPositionCost(facts).toFixed(2)}`,
  ];
  return lines.join("\n");
}

export function formatReplayReport(store: SqliteStore, requestedSessionId?: string): string {
  const facts = loadFacts(store, requestedSessionId);
  const matcher = new TranscriptMatcher(
    facts.binding.markets.map((market) => market.term),
    { minimumWordConfidence: 0.8, primarySpeaker: 0 },
  );
  const detected = new Set<string>();
  for (const segment of facts.transcripts) {
    for (const hit of matcher.ingest(segment).hits) detected.add(hit.marketId);
  }
  return [
    `Replay: ${facts.sessionId}`,
    `Network access: disabled`,
    `Order submission: disabled`,
    `Transcript segments: ${String(facts.transcripts.length)}`,
    `Reproduced mention hits: ${String(detected.size)}`,
    `Stored forecasts: ${String(facts.forecasts.length)}`,
    `Stored decisions: ${String(facts.decisions.length)}`,
  ].join("\n");
}

function loadFacts(store: SqliteStore, requestedSessionId?: string): StoredSessionFacts {
  const sessionId = requestedSessionId ?? store.latestSessionId();
  if (sessionId === undefined) throw new Error("No sessions have been recorded");
  return store.sessionFacts(sessionId);
}

function summarize(facts: StoredSessionFacts, strategy: Strategy): StrategySummary {
  const decisions = facts.decisions.filter((decision) => decision.strategy === strategy);
  const orders = facts.orders.filter((order) => order.intent.strategy === strategy);
  const intentIds = new Set(orders.map((order) => order.intent.id));
  const fills = facts.fills.filter(
    (fill) => fill.status !== "failed" && intentIds.has(fill.intentId),
  );
  return Object.freeze({
    decisions: decisions.length,
    accepted: decisions.filter((decision) => decision.accepted).length,
    orders: orders.length,
    fills: fills.length,
    spend: fills.reduce((total, fill) => total + fill.price * fill.shares, 0),
    fees: fills.reduce((total, fill) => total + fill.fee, 0),
  });
}

function strategyLine(strategy: Strategy, summary: StrategySummary): string {
  return `${strategy}: ${String(summary.accepted)}/${String(summary.decisions)} decisions accepted, ${String(summary.orders)} orders, ${String(summary.fills)} fills, $${summary.spend.toFixed(2)} spend, $${summary.fees.toFixed(4)} fees`;
}

function unresolvedPositionCost(facts: StoredSessionFacts): number {
  return facts.fills
    .filter((fill) => fill.status !== "failed")
    .reduce((total, fill) => total + fill.price * fill.shares + fill.fee, 0);
}
