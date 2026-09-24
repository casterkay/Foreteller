import type { TranscriptSegment } from "../domain/types.js";

/**
 * Retains the whole event transcript, replacing rather than appending ASR
 * hypotheses. Truncation belongs to the consumer that bounds a payload, so the
 * full text stays available for mention counting and replay.
 */
export class LiveTranscript {
  #confirmed: readonly string[] = [];
  #confirmedThroughMs = -Infinity;
  #previousRevision: string | undefined;

  /** Returns the full transcript for a new revision, or undefined for a replay. */
  public ingest(segment: TranscriptSegment): string | undefined {
    if (segment.sourceEndMs <= this.#confirmedThroughMs) return undefined;
    const revision = JSON.stringify([
      segment.sourceStartMs, segment.sourceEndMs, segment.text, segment.isFinal,
    ]);
    if (revision === this.#previousRevision) return undefined;
    this.#previousRevision = revision;
    const words = segment.text.trim().split(/\s+/u).filter(Boolean);
    const full = [...this.#confirmed, ...words];
    if (segment.isFinal) {
      this.#confirmed = full;
      this.#confirmedThroughMs = segment.sourceEndMs;
    }
    return full.join(" ");
  }
}

/** Keeps the newest `maximumWords` words, the speech closest to the cutoff. */
export function truncateToRecentWords(text: string, maximumWords: number): string {
  if (!Number.isInteger(maximumWords) || maximumWords <= 0) {
    throw new RangeError("maximumWords must be a positive integer");
  }
  const words = text.trim().split(/\s+/u).filter(Boolean);
  return words.length <= maximumWords ? words.join(" ") : words.slice(-maximumWords).join(" ");
}
