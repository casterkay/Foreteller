import { describe, expect, it } from "vitest";
import { TranscriptWindow } from "../../src/transcript/window.js";
import type { TranscriptSegment } from "../../src/domain/types.js";

function segment(text: string, end: number, isFinal = false): TranscriptSegment {
  return Object.freeze({ id: text, text, words: [], sourceStartMs: 0,
    sourceEndMs: end, receivedAtMs: end, isFinal });
}

describe("TranscriptWindow", () => {
  it("replaces interim hypotheses and commits finalized text exactly once", () => {
    const window = new TranscriptWindow(5);
    expect(window.ingest(segment("one two", 1, true))).toBe("one two");
    expect(window.ingest(segment("three wrong", 2))).toBe("one two three wrong");
    expect(window.ingest(segment("three four", 2))).toBe("one two three four");
    expect(window.ingest(segment("three four", 2, true))).toBe("one two three four");
    expect(window.ingest(segment("three four", 2, true))).toBeUndefined();
    expect(window.ingest(segment("five six seven", 3))).toBe("three four five six seven");
  });

  it("bounds each window by words and always retains the newest suffix", () => {
    for (let limit = 1; limit <= 40; limit += 1) {
      const window = new TranscriptWindow(limit);
      const allWords: string[] = [];
      for (let revision = 1; revision <= 50; revision += 1) {
        const words = Array.from({ length: revision % 7 + 1 }, (_, i) => `word${revision}-${i}`);
        allWords.push(...words);
        expect(window.ingest(segment(words.join(" \n "), revision, true)))
          .toBe(allWords.slice(-limit).join(" "));
      }
    }
  });

  it("ignores retransmissions and late hypotheses for committed speech", () => {
    const window = new TranscriptWindow(10);
    const interim = segment("hello", 1);
    expect(window.ingest(interim)).toBe("hello");
    expect(window.ingest(interim)).toBeUndefined();
    expect(window.ingest(segment("hello world", 2, true))).toBe("hello world");
    expect(window.ingest(interim)).toBeUndefined();
  });
});
