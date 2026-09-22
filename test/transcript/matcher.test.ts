import { describe, expect, it } from "vitest";

import type {
  TermSpec,
  TranscriptSegment,
  TranscriptWord,
} from "../../src/domain/types.js";
import { TranscriptMatcher } from "../../src/transcript/matcher.js";

function term(overrides: Partial<TermSpec> = {}): TermSpec {
  return Object.freeze({
    marketId: "market-1",
    label: "artificial intelligence",
    acceptedForms: ["artificial intelligence", "AI"],
    excludedForms: [],
    speakerScope: "anyone",
    windowStartMs: 0,
    windowEndMs: 60_000,
    ...overrides,
  });
}

function word(
  text: string,
  startMs: number,
  overrides: Partial<TranscriptWord> = {},
): TranscriptWord {
  return Object.freeze({
    text,
    startMs,
    endMs: startMs + 100,
    confidence: 0.95,
    ...overrides,
  });
}

function segment(
  id: string,
  words: readonly TranscriptWord[],
  overrides: Partial<TranscriptSegment> = {},
): TranscriptSegment {
  return Object.freeze({
    id,
    text: words.map((item) => item.text).join(" "),
    words,
    sourceStartMs: words[0]?.startMs ?? 0,
    sourceEndMs: words.at(-1)?.endMs ?? 0,
    receivedAtMs: 10_000,
    isFinal: true,
    ...overrides,
  });
}

describe("TranscriptMatcher", () => {
  it("matches accepted phrases across final segment boundaries with span evidence", () => {
    const matcher = new TranscriptMatcher([term()], {
      minimumWordConfidence: 0.8,
    });

    expect(
      matcher.ingest(segment("one", [word("Artificial", 1_000)])).hits,
    ).toEqual([]);
    const update = matcher.ingest(
      segment("two", [word("intelligence.", 1_200, { confidence: 0.87 })]),
    );

    expect(update.hits).toEqual([
      {
        marketId: "market-1",
        term: "artificial intelligence",
        transcript: "Artificial intelligence.",
        sourceStartMs: 1_000,
        sourceEndMs: 1_300,
        minimumConfidence: 0.87,
        segmentIds: ["one", "two"],
      },
    ]);
  });

  it("uses word boundaries and rejects overlapping excluded forms", () => {
    const matcher = new TranscriptMatcher(
      [
        term({
          acceptedForms: ["art", "trump"],
          excludedForms: ["donald trump jr"],
        }),
      ],
      { minimumWordConfidence: 0.8 },
    );

    expect(matcher.ingest(segment("party", [word("party", 100)])).hits).toEqual(
      [],
    );
    expect(matcher.ingest(segment("prefix", [word("Donald", 300)])).hits).toEqual(
      [],
    );
    expect(
      matcher.ingest(
        segment("excluded", [word("Trump", 500), word("Jr", 700)]),
      ).hits,
    ).toEqual([]);
    expect(matcher.ingest(segment("accepted", [word("art", 800)])).hits).toHaveLength(
      1,
    );
  });

  it("does not duplicate evidence when one ASR word contains punctuation", () => {
    const matcher = new TranscriptMatcher(
      [term({ acceptedForms: ["New York"] })],
      { minimumWordConfidence: 0.8 },
    );
    const update = matcher.ingest(segment("hyphenated", [word("New-York", 100)]));

    expect(update.hits[0]?.transcript).toBe("New-York");
  });

  it("keeps interim text speculative and deduplicates replayed final segments", () => {
    const matcher = new TranscriptMatcher(
      [term({ acceptedForms: ["AI"] })],
      { minimumWordConfidence: 0.8 },
    );
    const speculative = segment("interim", [word("AI", 1_000)], {
      isFinal: false,
    });

    const interimUpdate = matcher.ingest(speculative);
    expect(interimUpdate.interim).toBe(speculative);
    expect(interimUpdate.finalSegments).toEqual([]);
    expect(interimUpdate.hits).toEqual([]);

    const final = segment("request-a", [word("AI", 1_000)]);
    expect(matcher.ingest(final).hits).toHaveLength(1);
    const replay = segment("request-b", [word("AI", 1_000)]);
    const replayUpdate = matcher.ingest(replay);
    expect(replayUpdate.addedFinal).toBe(false);
    expect(replayUpdate.finalSegments).toEqual([final]);
    expect(replayUpdate.hits).toEqual([]);
  });

  it.each([
    {
      name: "wrong speaker",
      options: { minimumWordConfidence: 0.8, primarySpeaker: 1 },
      spec: term({ acceptedForms: ["AI"], speakerScope: "primary" }),
      words: [word("AI", 1_000, { speaker: 2 })],
    },
    {
      name: "missing primary speaker identity",
      options: { minimumWordConfidence: 0.8 },
      spec: term({ acceptedForms: ["AI"], speakerScope: "primary" }),
      words: [word("AI", 1_000, { speaker: 1 })],
    },
    {
      name: "outside the qualifying window",
      options: { minimumWordConfidence: 0.8 },
      spec: term({
        acceptedForms: ["AI"],
        windowStartMs: 2_000,
        windowEndMs: 3_000,
      }),
      words: [word("AI", 1_000)],
    },
    {
      name: "confidence below the floor",
      options: { minimumWordConfidence: 0.8 },
      spec: term({ acceptedForms: ["AI"] }),
      words: [word("AI", 1_000, { confidence: 0.79 })],
    },
  ])("rejects a matching phrase with $name", ({ options, spec, words }) => {
    const matcher = new TranscriptMatcher([spec], options);
    expect(matcher.ingest(segment("segment", words)).hits).toEqual([]);
  });

  it("accepts the primary speaker at the confidence and window boundaries", () => {
    const matcher = new TranscriptMatcher(
      [
        term({
          acceptedForms: ["AI"],
          speakerScope: "primary",
          windowStartMs: 1_000,
          windowEndMs: 1_100,
        }),
      ],
      { minimumWordConfidence: 0.8, primarySpeaker: 1 },
    );
    expect(
      matcher.ingest(
        segment("boundary", [
          word("AI", 1_000, { confidence: 0.8, speaker: 1 }),
        ]),
      ).hits,
    ).toHaveLength(1);
  });
});
