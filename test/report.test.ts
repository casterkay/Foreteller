import { describe, expect, it } from "vitest";

import { defaultLimits } from "../src/config.js";
import type { SessionBinding, TranscriptSegment } from "../src/domain/types.js";
import { formatReplayReport, formatSessionReport } from "../src/report.js";
import { SqliteStore } from "../src/storage/index.js";
import { decideSniperOrder, type SniperDecisionInput } from "../src/strategy/index.js";

const binding: SessionBinding = Object.freeze({
  sessionId: "session-1",
  eventId: "event-1",
  eventTitle: "Policy speech",
  rulesHash: "rules",
  videoUrl: "https://www.youtube.com/watch?v=abc",
  videoId: "abc",
  channelId: "channel",
  speaker: "Ada Lovelace",
  expectedStartMs: 1_000,
  expectedEndMs: 10_000,
  confirmedAtMs: 900,
  markets: Object.freeze([
    Object.freeze({
      eventId: "event-1",
      marketId: "market-1",
      question: "Will Ada mention AI?",
      description: "Resolves YES if Ada says AI.",
      yesTokenId: "yes",
      noTokenId: "no",
      tickSize: 0.01,
      minimumOrderSize: 5,
      negRisk: false,
      acceptingOrders: true,
      feeRate: 0,
      term: Object.freeze({
        marketId: "market-1",
        label: "AI",
        acceptedForms: Object.freeze(["AI"]),
        excludedForms: Object.freeze([]),
        speakerScope: "primary",
        windowStartMs: 1_000,
        windowEndMs: 10_000,
        mentionThreshold: 1,
      }),
    }),
  ]),
});

const segment: TranscriptSegment = Object.freeze({
  id: "segment-1",
  text: "AI",
  words: Object.freeze([
    Object.freeze({ text: "AI", startMs: 2_000, endMs: 2_100, confidence: 0.95, speaker: 0 }),
  ]),
  sourceStartMs: 2_000,
  sourceEndMs: 2_100,
  receivedAtMs: 2_200,
  isFinal: true,
});

describe("session reporting", () => {
  it("summarizes stored facts and replays mentions without network access", () => {
    const store = new SqliteStore(":memory:");
    store.recordSession(binding.sessionId, "waiting", 900);
    store.recordBinding(binding);
    store.recordTranscript(binding.sessionId, segment);
    store.recordForecast(
      binding.sessionId,
      {
        marketId: "market-1",
        probability: 0.7,
        model: "jev-test",
        snapshotAtMs: 2_200,
        latencyMs: 50,
      },
      2_250,
    );
    const market = binding.markets[0];
    if (market === undefined) throw new Error("fixture market missing");
    const input: SniperDecisionInput = {
      mention: {
        marketId: market.marketId,
        term: "ai",
        transcript: "AI",
        sourceStartMs: 2_000,
        sourceEndMs: 2_100,
        minimumConfidence: 0.95,
        segmentIds: ["segment-1"],
        mentionCount: 1,
      },
      mentionCountsComplete: true,
      market,
      book: {
        tokenId: market.yesTokenId,
        bids: [],
        asks: [],
        tickSize: market.tickSize,
        receivedAtMs: 2_200,
        synchronized: false,
      },
      nowMs: 2_200,
      remainingAllowance: 20,
      attempts: 0,
      lastAttemptAtMs: undefined,
      limits: defaultLimits,
    };
    const decision = decideSniperOrder(input);
    store.recordDecision({
      id: "decision-1",
      sessionId: binding.sessionId,
      eventId: binding.eventId,
      marketId: market.marketId,
      strategy: "sniper",
      accepted: decision.accepted,
      reason: decision.accepted ? "accepted" : decision.reason,
      evidenceJson: JSON.stringify({ input, timing: { observedAgeMs: 100 }, decision }),
      createdAtMs: 2_200,
    });

    expect(formatSessionReport(store)).toContain("Event: Policy speech");
    expect(formatSessionReport(store)).toContain("Forecasts: 1");
    expect(formatReplayReport(store)).toContain("Reproduced mention hits: 1");
    expect(formatReplayReport(store)).toContain("Reproduced decisions: 1");
    expect(formatReplayReport(store)).toContain("Decision mismatches: 0");
    expect(formatReplayReport(store)).toContain("Network access: disabled");
    store.close();
  });
});
