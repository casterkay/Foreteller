import type { TranscriptSegment } from "../domain/types.js";

/** Retains confirmed words and replaces, rather than appends, ASR hypotheses. */
export class TranscriptWindow {
  private confirmed: readonly string[] = [];
  private confirmedThroughMs = -Infinity;
  private previousRevision: string | undefined;

  public constructor(private readonly maximumWords: number) {
    if (!Number.isInteger(maximumWords) || maximumWords <= 0) {
      throw new RangeError("maximumWords must be a positive integer");
    }
  }

  public ingest(segment: TranscriptSegment): string | undefined {
    if (segment.sourceEndMs <= this.confirmedThroughMs) return undefined;
    const revision = JSON.stringify([
      segment.sourceStartMs, segment.sourceEndMs, segment.text, segment.isFinal,
    ]);
    if (revision === this.previousRevision) return undefined;
    this.previousRevision = revision;
    const words = segment.text.trim().split(/\s+/u).filter(Boolean);
    const recent = [...this.confirmed, ...words].slice(-this.maximumWords);
    if (segment.isFinal) {
      this.confirmed = recent;
      this.confirmedThroughMs = segment.sourceEndMs;
    }
    return recent.join(" ");
  }
}
