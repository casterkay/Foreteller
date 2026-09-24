# Jev Live Mention-Market Strategy

Status: proposed, research-only
Date: 2026-09-19
Owner: Polymath

## 1. Goal

Trade selected Polymarket mention markets by forecasting whether a qualifying
term will be spoken before a live event ends.

The initial strategy:

- watches major scheduled events carried live on YouTube;
- transcribes the confirmed stream continuously;
- asks Jev whether each unresolved term will be mentioned before the event
  ends;
- buys YES only when the calibrated forecast exceeds executable cost by a
  validated margin.

The intended edge is prediction before the term is spoken, not racing the
market after detecting it.

This is a research hypothesis. No strategy code or LIVE permission is justified
until the recorder, replay, calibration, and simulated-execution gates in
Section 9 pass.

## 2. Scope

Start with bundled mention markets for major English-language public events,
especially:

- United Nations General Assembly speeches by major heads of state or
  government;
- presidential addresses and major press conferences;
- central-bank speeches and press conferences;
- congressional or parliamentary hearings;
- other scheduled appearances with a named speaker, bounded event, and direct
  YouTube livestream.

Examples include:

- "What will Trump say during the United Nations General Assembly?"
- "What will Netanyahu say during the United Nations General Assembly?"

An event is eligible only when its Polymarket rules and surrounding context make
all of the following reasonably clear:

1. whose speech counts;
2. which event and time interval count;
3. what constitutes a qualifying mention;
4. that a contemporaneous YouTube livestream is expected;
5. that the stream carries the qualifying speech directly, rather than later
   reporting or commentary;
6. that the same stream can resolve the selected bundle of mention contracts.

Initial exclusions:

- count markets whose outcome bounds the count from above ("at most", "fewer
  than", "exactly", "between") — YES-only sizing cannot express them;
- social-post, article, or prerecorded-release markets;
- sports commentary and other markets whose outcome depends primarily on
  non-linguistic state;
- events without a reliable scheduled start;
- ambiguous speakers, event boundaries, mention rules, or source coverage;
- streams dominated by translation, voice-over, excerpts, or commentary when
  those may change what counts;
- non-English events until ASR and forecasting are validated for that language.

Liquidity and executable prices affect whether an eligible contract can be
traded, but not whether the event and stream match.

## 3. Architecture

```text
Polymarket Gamma                 YouTube search through yt-dlp
        |                                      |
        v                                      v
active mention events                  live/upcoming videos
        |                                      |
        +----------> Discovery Engine <--------+
                           |
                 LLM-ranked event/video pairs
                           |
                    user confirmation
                           |
                     confirmed binding
                           |
              yt-dlp audio -> streaming ASR
                           |
              transcript + exact mention state
                           |
                     Jev forecasts
                           |
                 NautilusTrader strategy
                           |
             books, risk, orders, fills, PnL
```

The Discovery Engine owns candidate collection, semantic shortlisting, and the
confirmation workflow. It does not own media processing, forecasting, or
execution.

The media and Jev pipeline publishes immutable forecast data into the existing
NautilusTrader system. It never submits orders directly.

## 4. Discovery Engine

### 4.1 Polymarket candidate collection

Periodically fetch active, open Polymarket events and their markets from Gamma.
Use the Mentions category or tags as a search aid, not as proof of eligibility.
Keep structurally valid candidates whose title, description, or rules indicate
that named words or phrases spoken during a bounded event determine resolution.

Before invoking the LLM, discard candidates that are closed, malformed,
non-mention markets, count markets, or lack their full rules and event timing.

The LLM then shortlists events using the complete event title, market titles,
rules, scheduled time, speaker, venue, source language, and relevant market
context. It returns structured output containing:

```text
EventCandidate
--------------
event reference and title
selected mention contracts
speaker
event name
scheduled start and expected end, if known
accepted and excluded mention forms
why the event is suitable for live YouTube resolution
ambiguities and rejection reasons
shortlist confidence
```

The LLM may reject an entire event or select only the contracts whose rules are
clear. It must quote the exact rule fragments supporting each material field so
the user can verify its interpretation. Missing or conflicting facts remain
explicit; the LLM must not invent them.

### 4.2 YouTube search

At the candidate event's scheduled start, search YouTube through `yt-dlp`.
Build several narrow queries from the speaker, event, organization, venue, and
date. Search failures use bounded retries and remain visible; an empty result is
not evidence that no stream exists.

Use `yt-dlp` first for search and metadata only. Retain results whose extracted
`live_status` is `is_upcoming` or `is_live`. Discard ordinary uploads, completed
streams, clips, and results without a stable video URL and channel identity.
`yt-dlp` documents these status values and YouTube search support in its
[README](https://github.com/yt-dlp/yt-dlp/blob/master/README.md).

For every retained result, collect only the metadata needed to judge the match:

```text
VideoCandidate
--------------
video ID and URL
title and description
channel name and channel ID
live status
scheduled or actual start time
language, when available
```

Do not download media during discovery.

### 4.3 LLM pair shortlisting

Give the LLM the shortlisted Polymarket events and filtered YouTube candidates
in one request. It evaluates event/video pairs rather than ranking videos in
isolation.

The ranking criteria, in order, are:

1. the video depicts the same speaker at the same qualifying event;
2. its scheduled or actual time overlaps the Polymarket event;
3. it is carried by the official organizer, speaker, government, or another
   credible direct broadcaster;
4. its title, description, channel, and event context agree;
5. its audio is expected to contain the complete qualifying speech without
   commentary or substitution.

The LLM returns at most a small operator-readable shortlist. Each proposed pair
must include:

- the Polymarket event and covered contracts;
- the YouTube video and channel;
- the evidence for the match;
- unresolved discrepancies;
- a confidence label;
- an explicit `REJECT` result when no candidate is adequate.

Confidence never grants authority. A high-confidence LLM result still requires
user confirmation.

### 4.4 Confirmation and binding

Present the shortlisted pairs to the user. The confirmation view must show the
market rules alongside the video title, channel, status, timing, match reasons,
and ambiguities. The user may confirm one pair or reject all candidates.

A confirmation creates an immutable binding containing:

```text
ConfirmedStreamBinding
----------------------
Polymarket event reference
selected contracts and rules hash
YouTube video ID and URL
channel ID
scheduled event interval
LLM assessment and model version
confirmation time and confirming user
```

Only a confirmed binding may start media ingestion. Never switch to a different
video automatically. A rule change, video replacement, channel change, or
material timing conflict invalidates the binding and requires confirmation
again.

## 5. Live transcript and mention state

Once the confirmed video is live, use `yt-dlp` to provide its audio stream to
streaming ASR. Record the exact `yt-dlp` version and video identity. Treat
extractor failure, unavailable audio, or excessive source delay as explicit
suspension states.

Maintain:

- a short speculative transcript containing current ASR hypotheses;
- an append-only confirmed transcript made from finalized ASR segments;
- deterministic mention state for every contract.

ASR revisions replace earlier hypotheses; they never append duplicate text.
Jev may consume speculative text for early forecasting, but only finalized text
may establish that a term has already been spoken. Ambiguous acronyms,
homophones, translations, or overlapping speakers require review or a validated
secondary verifier.

The exact matcher implements the confirmed contract rules. Jev does not decide
whether a past mention qualifies.

## 6. Forecast and signal

For each unresolved contract, Jev receives one compact shared event state:

- recent verbatim transcript;
- a reproducible summary of earlier speech;
- current speaker, topic, and event phase;
- elapsed and estimated remaining time;
- the contract's qualifying mention rule.

Do not include market price, our position, earlier model probabilities, or
public live chat. The forecast should remain independent of the market.

Ask all unresolved terms for one event in a single request:

> Will the qualifying speaker mention this term after the transcript cutoff and
> before the qualifying event ends?

Persist the request state, exact model version, raw probability, timestamps,
and response. Calibrate probabilities out of sample before using them for
trading.

For intended size, compare calibrated probability with the executable YES cost
from the live order book, including the venue's current fee schedule and the
configured execution buffer. Initial execution is YES-only and conservatively
sized under a shared event exposure cap because contracts within one speech are
correlated.

The existing Polymarket adapter and NautilusTrader strategy remain authoritative
for market data, risk, orders, fills, positions, reconciliation, and accounting.

## 7. Failure behavior

No new order may be created when any of these is true:

- there is no user-confirmed binding;
- the Polymarket rules hash changed;
- the confirmed video is not live or no longer matches the binding;
- source, transcript, or forecast data exceed their configured age;
- the speaker or qualifying event cannot be established;
- ASR or Jev failed, timed out, or returned malformed output;
- the event ended or the contract was already satisfied;
- executable price, fee, position, or risk state is unavailable.

The recorder should continue whenever safe even when forecasting or trading is
suspended. Auxiliary discovery failures must be visible but must not disturb
unrelated trading services.

## 8. Evidence and replay

Persist enough data to reproduce every shortlist, confirmation, forecast, and
decision:

- Gamma event and market snapshots with full rules;
- YouTube search queries and filtered `yt-dlp` metadata;
- LLM prompts, structured outputs, model versions, and rejected candidates;
- user confirmation or rejection;
- confirmed binding and every invalidation;
- audio/source timestamps and finalized transcript revisions;
- Jev state, probabilities, and model versions;
- order-book snapshot, current fee schedule, decision, order, fill, and PnL.

The primary latency measure is the age of source content when an order is
submitted, not merely ASR, Jev, or API round-trip latency.

Replay must use only information available at each historical decision time.
Realized mentions and eventual outcomes may score a forecast but may never
select the observation or tune the same evaluation sample.

## 9. Delivery gates

### Phase 0: discovery recorder

Run the Discovery Engine without media ingestion or trading. Measure:

- eligible-event precision and recall under human review;
- pair-shortlist precision and rank of the confirmed video;
- false matches by failure class;
- time from scheduled start to a confirmable live candidate;
- events for which no adequate YouTube stream exists.

The gate passes only when incorrect event/video pairs are rare, clearly
explained, and never activated without confirmation.

### Phase 1: transcript and forecast shadowing

Ingest confirmed streams, produce transcripts and Jev forecasts, and place no
orders. Measure mention-detection errors, forecast calibration, Brier score,
log loss, source age, and end-to-end latency against market-price and simple
base-rate baselines.

### Phase 2: simulated execution

Replay and paper-trade with recorded books, current historical fee schedules,
realistic latency, slippage, missed fills, correlated event exposure, and
source failures. Report net follower PnL and calibration, not source-model
accuracy alone.

### Phase 3: bounded LIVE canary

Requires separate user approval after the prior gates pass, an independent
review, current deployment evidence, and explicit LIVE limits. Initial LIVE
scope remains YES-only with small per-contract and per-event exposure.

## 10. MVP acceptance criteria

The research MVP is complete when it can:

1. collect active Polymarket mention events and use an LLM to shortlist only
   events plausibly resolvable from a concurrent YouTube livestream;
2. start `yt-dlp` YouTube search at the scheduled event start and retain only
   live or upcoming results;
3. use an LLM to shortlist and explain event/video pairs;
4. present the market rules and video evidence for user confirmation;
5. ingest audio only from the confirmed video and never substitute a source
   automatically;
6. reconstruct the confirmed transcript, Jev input, forecast, and simulated
   decision from recorded artifacts;
7. fail closed for trading while keeping discovery and recording failures
   explicit and recoverable.


## Transcript-driven inference and extension delivery

Each distinct transcript revision, including interim ASR hypotheses and finalized
segments, triggers one batched Jev request for unresolved terms. Finalized speech
is retained once; the current interim hypothesis replaces the previous hypothesis.
The full transcript is retained for the whole event so mention counts stay exact;
only the payload Jev receives is left-truncated to the newest
`TRANSCRIPT_MAXIMUM_WORDS` words (default 1,000). Do not trigger inference on book
changes or periodic timers. There is no inference cooldown or in-flight coalescing.
Bound each call by its request timeout and cancel it when the session ends.
Completed responses carry revision ordering: an older response cannot overwrite a
newer forecast. Only confirmed transcripts can establish qualifying mentions.

At-least count markets (`TERM N+ times`) are forecast as the remaining mentions:
Jev is asked whether the term will be mentioned at least `N = M - K` more times,
where `M` is the threshold and `K` is the qualifying mentions counted so far from
the full transcript. A count market is forecastable only when transcription
covered the qualifying event from its start; otherwise the counted past is a
floor and the market is excluded from that session rather than understated.

The extension receives state changes immediately over a persistent connection,
reconciles current state after reconnecting, and retains market DOM nodes for
smooth marker transitions. Respect reduced-motion preferences.
