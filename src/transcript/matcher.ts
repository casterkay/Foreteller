import type {
  MentionHit,
  TermSpec,
  TranscriptSegment,
  TranscriptWord,
} from "../domain/types.js";

interface IndexedWord extends TranscriptWord {
  readonly normalized: string;
  readonly segmentId: string;
  readonly wordIndex: number;
}

interface CompiledTerm {
  readonly spec: TermSpec;
  readonly accepted: readonly (readonly string[])[];
  readonly excluded: readonly (readonly string[])[];
}

export interface TranscriptUpdate {
  readonly addedFinal: boolean;
  readonly finalSegments: readonly TranscriptSegment[];
  readonly interim: TranscriptSegment | null;
  readonly hits: readonly MentionHit[];
}

export interface TranscriptMatcherOptions {
  readonly minimumWordConfidence: number;
  readonly primarySpeaker?: number;
}

function normalize(text: string): readonly string[] {
  return Array.from(
    text.toLocaleLowerCase("en-US").matchAll(/[\p{L}\p{N}]+(?:['\u2019][\p{L}\p{N}]+)*/gu),
    (match) => match[0]?.replaceAll("\u2019", "'") ?? "",
  ).filter((token) => token.length > 0);
}

function compile(spec: TermSpec): CompiledTerm {
  const accepted = spec.acceptedForms.map(normalize).filter((form) => form.length > 0);
  if (accepted.length === 0) {
    throw new Error(`Term ${spec.marketId} has no usable accepted forms`);
  }
  return Object.freeze({
    spec,
    accepted,
    excluded: spec.excludedForms.map(normalize).filter((form) => form.length > 0),
  });
}

function matchesAt(
  words: readonly IndexedWord[],
  start: number,
  pattern: readonly string[],
): boolean {
  if (start + pattern.length > words.length) return false;
  return pattern.every(
    (token, offset) => words[start + offset]?.normalized === token,
  );
}

function overlapsExcluded(
  words: readonly IndexedWord[],
  start: number,
  end: number,
  excluded: readonly (readonly string[])[],
): boolean {
  return excluded.some((pattern) => {
    const firstStart = Math.max(0, start - pattern.length + 1);
    const lastStart = Math.min(end - 1, words.length - pattern.length);
    for (let candidate = firstStart; candidate <= lastStart; candidate += 1) {
      if (matchesAt(words, candidate, pattern)) return true;
    }
    return false;
  });
}

function fingerprint(segment: TranscriptSegment): string {
  return `${segment.sourceStartMs}:${segment.sourceEndMs}:${normalize(segment.text).join(" ")}`;
}

export class TranscriptMatcher {
  readonly #terms: readonly CompiledTerm[];
  readonly #minimumWordConfidence: number;
  readonly #primarySpeaker: number | undefined;
  readonly #segmentIds = new Set<string>();
  readonly #segmentFingerprints = new Set<string>();
  readonly #matchedMarkets = new Set<string>();
  #finalSegments: readonly TranscriptSegment[] = Object.freeze([]);
  #words: readonly IndexedWord[] = Object.freeze([]);
  #interim: TranscriptSegment | null = null;

  constructor(terms: readonly TermSpec[], options: TranscriptMatcherOptions) {
    if (
      !Number.isFinite(options.minimumWordConfidence) ||
      options.minimumWordConfidence < 0 ||
      options.minimumWordConfidence > 1
    ) {
      throw new RangeError("minimumWordConfidence must be between 0 and 1");
    }
    this.#terms = terms.map(compile);
    this.#minimumWordConfidence = options.minimumWordConfidence;
    this.#primarySpeaker = options.primarySpeaker;
  }

  get matchedMarketIds(): ReadonlySet<string> {
    return new Set(this.#matchedMarkets);
  }

  ingest(segment: TranscriptSegment): TranscriptUpdate {
    if (!segment.isFinal) {
      this.#interim = segment;
      return this.#update(false, []);
    }

    const segmentFingerprint = fingerprint(segment);
    if (
      this.#segmentIds.has(segment.id) ||
      this.#segmentFingerprints.has(segmentFingerprint)
    ) {
      return this.#update(false, []);
    }

    const oldWordCount = this.#words.length;
    const newWords = segment.words.flatMap((word, wordIndex): readonly IndexedWord[] => {
      const tokens = normalize(word.text);
      return tokens.map((token) =>
        Object.freeze({
          ...word,
          normalized: token,
          segmentId: segment.id,
          wordIndex,
        }),
      );
    });
    this.#segmentIds.add(segment.id);
    this.#segmentFingerprints.add(segmentFingerprint);
    this.#finalSegments = Object.freeze([...this.#finalSegments, segment]);
    this.#words = Object.freeze([...this.#words, ...newWords]);
    this.#interim = null;

    const hits: MentionHit[] = [];
    for (const term of this.#terms) {
      if (this.#matchedMarkets.has(term.spec.marketId)) continue;
      const hit = this.#findHit(term, oldWordCount);
      if (hit === undefined) continue;
      this.#matchedMarkets.add(term.spec.marketId);
      hits.push(hit);
    }
    return this.#update(true, hits);
  }

  #findHit(term: CompiledTerm, oldWordCount: number): MentionHit | undefined {
    for (const form of term.accepted) {
      const firstStart = Math.max(0, oldWordCount - form.length + 1);
      for (let start = firstStart; start + form.length <= this.#words.length; start += 1) {
        const end = start + form.length;
        if (end <= oldWordCount || !matchesAt(this.#words, start, form)) continue;
        if (overlapsExcluded(this.#words, start, end, term.excluded)) continue;
        const span = this.#words.slice(start, end);
        const first = span[0];
        const last = span.at(-1);
        if (first === undefined || last === undefined) continue;
        if (
          first.startMs < term.spec.windowStartMs ||
          last.endMs > term.spec.windowEndMs
        ) {
          continue;
        }
        const minimumConfidence = Math.min(...span.map((word) => word.confidence));
        if (minimumConfidence < this.#minimumWordConfidence) continue;
        if (
          term.spec.speakerScope === "primary" &&
          (this.#primarySpeaker === undefined ||
            span.some((word) => word.speaker !== this.#primarySpeaker))
        ) {
          continue;
        }
        return Object.freeze({
          marketId: term.spec.marketId,
          term: form.join(" "),
          transcript: Array.from(
            new Map(
              span.map((word) => [
                `${word.segmentId}:${String(word.wordIndex)}`,
                word.text,
              ]),
            ).values(),
          ).join(" "),
          sourceStartMs: first.startMs,
          sourceEndMs: last.endMs,
          minimumConfidence,
          segmentIds: Object.freeze(Array.from(new Set(span.map((word) => word.segmentId)))),
        });
      }
    }
    return undefined;
  }

  #update(
    addedFinal: boolean,
    hits: readonly MentionHit[],
  ): TranscriptUpdate {
    return Object.freeze({
      addedFinal,
      finalSegments: this.#finalSegments,
      interim: this.#interim,
      hits: Object.freeze([...hits]),
    });
  }
}
