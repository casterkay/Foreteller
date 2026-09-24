import { describe, expect, it } from "vitest";
import { LiveTranscript, truncateToRecentWords } from "../../src/transcript/transcript.js";
import type { TranscriptSegment } from "../../src/domain/types.js";

function segment(text: string, end: number, isFinal = false): TranscriptSegment {
  return Object.freeze({ id: text, text, words: [], sourceStartMs: 0,
    sourceEndMs: end, receivedAtMs: end, isFinal });
}

describe("LiveTranscript", () => {
  it("replaces interim hypotheses and commits finalized text exactly once", () => {
    const transcript = new LiveTranscript();
    expect(transcript.ingest(segment("one two", 1, true))).toBe("one two");
    expect(transcript.ingest(segment("three wrong", 2))).toBe("one two three wrong");
    expect(transcript.ingest(segment("three four", 2))).toBe("one two three four");
    expect(transcript.ingest(segment("three four", 2, true))).toBe("one two three four");
    expect(transcript.ingest(segment("three four", 2, true))).toBeUndefined();
    expect(transcript.ingest(segment("five six seven", 3))).toBe("one two three four five six seven");
  });

  it("retains the full confirmed transcript without truncation", () => {
    const transcript = new LiveTranscript();
    const allWords: string[] = [];
    for (let revision = 1; revision <= 40; revision += 1) {
      const words = Array.from({ length: 7 }, (_, i) => `w${revision}-${i}`);
      allWords.push(...words);
      expect(transcript.ingest(segment(words.join(" "), revision, true)))
        .toBe(allWords.join(" "));
    }
  });

  it("ignores retransmissions and late hypotheses for committed speech", () => {
    const transcript = new LiveTranscript();
    const interim = segment("hello", 1);
    expect(transcript.ingest(interim)).toBe("hello");
    expect(transcript.ingest(interim)).toBeUndefined();
    expect(transcript.ingest(segment("hello world", 2, true))).toBe("hello world");
    expect(transcript.ingest(interim)).toBeUndefined();
  });
});

describe("truncateToRecentWords", () => {
  it("keeps the newest suffix and returns the text unchanged when under the limit", () => {
    expect(truncateToRecentWords("one two three four five", 3)).toBe("three four five");
    expect(truncateToRecentWords("one two", 3)).toBe("one two");
    expect(truncateToRecentWords("  one   two  ", 3)).toBe("one two");
  });

  it("rejects a non-positive maximum", () => {
    expect(() => truncateToRecentWords("text", 0)).toThrow(RangeError);
    expect(() => truncateToRecentWords("text", 1.5)).toThrow(RangeError);
  });
});
