import type { Strategy } from "./domain/types.js";
import type { SqliteStore, StoredSessionFacts } from "./storage/index.js";
import {
  decideForecastOrder,
  decideSniperOrder,
  type ForecastDecisionInput,
  type SniperDecisionInput,
  type StrategyDecision,
} from "./strategy/index.js";
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
  const ages = decisionAges(facts);
  const forecastLatencies = facts.forecasts.map((forecast) => forecast.latencyMs);
  const positions = positionSummary(facts);
  const lines = [
    `Session: ${facts.sessionId}`,
    `Event: ${facts.binding.eventTitle}`,
    `Status: ${facts.status}`,
    `Reconciliation: ${facts.orders.some((order) => order.status === "unknown") ? "required" : "clear"}`,
    strategyLine("sniper", summarize(facts, "sniper")),
    strategyLine("forecast", summarize(facts, "forecast")),
    `Transcripts: ${String(facts.transcripts.length)}`,
    `Mention detections: ${String(replayMentions(facts).size)}`,
    `Forecasts: ${String(facts.forecasts.length)}`,
    `Forecast batches: ${String(facts.forecastBatches.length)}`,
    `Maximum observed audio age: ${formatMaximum(ages, "ms")}`,
    `Maximum forecast latency: ${formatMaximum(forecastLatencies, "ms")}`,
    `Execution errors: ${String(facts.orders.filter((order) => order.status === "failed" || order.status === "unknown").length)}`,
    `Resolved markets: ${String(positions.resolvedMarkets)}`,
    `Realized P&L: $${positions.realizedPnl.toFixed(2)}`,
    `Unresolved position cost: $${positions.unresolvedCost.toFixed(2)}`,
  ];
  return lines.join("\n");
}

export function formatReplayReport(store: SqliteStore, requestedSessionId?: string): string {
  const facts = loadFacts(store, requestedSessionId);
  const detected = replayMentions(facts);
  const decisions = replayDecisions(facts);
  return [
    `Replay: ${facts.sessionId}`,
    `Network access: disabled`,
    `Order submission: disabled`,
    `Transcript segments: ${String(facts.transcripts.length)}`,
    `Reproduced mention hits: ${String(detected.size)}`,
    `Stored forecasts: ${String(facts.forecasts.length)}`,
    `Stored decisions: ${String(facts.decisions.length)}`,
    `Reproduced decisions: ${String(decisions.reproduced)}`,
    `Decision mismatches: ${String(decisions.mismatched)}`,
  ].join("\n");
}

function replayMentions(facts: StoredSessionFacts): ReadonlySet<string> {
  const matcher = new TranscriptMatcher(
    facts.binding.markets.map((market) => market.term),
    { minimumWordConfidence: 0.8, primarySpeaker: facts.binding.primarySpeaker ?? 0 },
  );
  const detected = new Set<string>();
  for (const segment of facts.transcripts) {
    for (const hit of matcher.ingest(segment).hits) detected.add(hit.marketId);
  }
  return detected;
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

function replayDecisions(facts: StoredSessionFacts): {
  readonly reproduced: number;
  readonly mismatched: number;
} {
  let reproduced = 0;
  let mismatched = 0;
  for (const stored of facts.decisions) {
    try {
      const evidence = JSON.parse(stored.evidenceJson) as {
        readonly input: SniperDecisionInput | ForecastDecisionInput;
        readonly decision: StrategyDecision;
      };
      const replayed = stored.strategy === "sniper"
        ? decideSniperOrder(evidence.input as SniperDecisionInput)
        : decideForecastOrder(evidence.input as ForecastDecisionInput);
      if (JSON.stringify(replayed) === JSON.stringify(evidence.decision)) reproduced += 1;
      else mismatched += 1;
    } catch (error: unknown) {
      if (error instanceof Error) mismatched += 1;
      else throw error;
    }
  }
  return Object.freeze({ reproduced, mismatched });
}

function decisionAges(facts: StoredSessionFacts): readonly number[] {
  return facts.decisions.flatMap((decision) => {
    try {
      const evidence = JSON.parse(decision.evidenceJson) as {
        readonly timing?: { readonly observedAgeMs?: unknown };
      };
      const age = evidence.timing?.observedAgeMs;
      return typeof age === "number" && Number.isFinite(age) ? [age] : [];
    } catch (error: unknown) {
      if (error instanceof SyntaxError) return [];
      throw error;
    }
  });
}

function positionSummary(facts: StoredSessionFacts): {
  readonly resolvedMarkets: number;
  readonly realizedPnl: number;
  readonly unresolvedCost: number;
} {
  const outcomes = new Map(facts.outcomes.map((outcome) => [outcome.marketId, outcome.outcome]));
  const orders = new Map(facts.orders.map((order) => [order.intent.id, order.intent]));
  let realizedPnl = 0;
  let unresolvedCost = 0;
  for (const fill of facts.fills) {
    if (fill.status === "failed") continue;
    const marketId = orders.get(fill.intentId)?.marketId;
    const outcome = marketId === undefined ? undefined : outcomes.get(marketId);
    const cost = fill.price * fill.shares + fill.fee;
    if (outcome === "yes") realizedPnl += fill.shares - cost;
    else if (outcome === "no") realizedPnl -= cost;
    else unresolvedCost += cost;
  }
  return Object.freeze({
    resolvedMarkets: [...outcomes.values()].filter(
      (outcome) => outcome === "yes" || outcome === "no",
    ).length,
    realizedPnl,
    unresolvedCost,
  });
}

function formatMaximum(values: readonly number[], unit: string): string {
  return values.length === 0 ? "n/a" : `${String(Math.max(...values))} ${unit}`;
}
