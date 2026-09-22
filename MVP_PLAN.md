# WindListener MVP Plan

Status: proposed
Date: 2026-09-21
Supersedes: `jev-live-mention-market-strategy.md` §4.2–4.4 (automatic YouTube matching)
and §3's Discovery Engine. Everything else in that document still applies.

Operator decisions folded into this revision:

- **Live immediately**, no shadow-only gate.
- **Constant $5 notional for the Jev forecast trade.** $5 clears every candidate reading
  of the venue's order minimum at every price (§8.2), so the documented ambiguity in
  §11 issue 1 stops being a blocker.
- **The sniper gets its own, larger allowance: $20 per market.**
- **Hold every position to resolution** — no exits, no resting orders.
- **Two strategies, not one.** A deterministic "already said it" sniper runs alongside
  the Jev forecast.
- **Jev is TypeSafe's System One model**, used through Noul questions.
- **Taker fee is `rate × p × (1 − p)` per share**, p = filled price; max 1¢/share at
  p = 0.50.

---

## 1. What changed from the research doc

Automatic Polymarket↔YouTube matching is dropped. It needed two LLM ranking stages,
yt-dlp search, and a confirmation UI to produce one bit of information a human can
supply in five seconds.

The MVP replaces it with: a scanner polls the Polymarket **Mentions** tag and pushes
new events to Telegram → the operator adds an event to a **watchlist** and pastes the
YouTube URL → when that video goes live the **session runner** starts automatically,
opens the CLOB stream for every market in the event plus the ASR transcript stream,
merges them into one tick, and runs both strategies until the event ends.

---

## 2. Ground truth

Measured live against Gamma and the CLOB on 2026-09-21. These numbers drive the design.

**The tag slug is `mention-markets`** (id `100343`, label "Mentions"). `mentions` 404s.

Of ~11 open Mentions events, only **2–4 are genuinely a live YouTube stream** (political
speeches, PMQs). Earnings calls are webcasts, UFC/Big Brother are paywalled broadcasts,
podcasts are published rather than streamed, and the Trump/Elon events are month-long
aggregates over social posts. Expect 2–4 tradeable sessions per week.

Per-market depth, all 17 markets in the current Joe Rogan event:

```
People 200+ times      bid=0.25  ask=0.48   liq=$73    tick=0.01
People 100+ times      bid=0.81  ask=0.84   liq=$321   tick=0.01
Dude 20+ times         bid=0.354 ask=0.424  liq=$139   tick=0.001
Trump 10+ times        bid=0.09  ask=0.31   liq=$113   tick=0.01
Fuck / Fucking 10+     bid=0.79  ask=0.80   liq=$286   tick=0.01
World Cup              bid=0.076 ask=0.116  liq=$536   tick=0.001
Alien                  bid=0.42  ask=0.50   liq=$86    tick=0.01
Tesla                  bid=0.233 ask=0.302  liq=$172   tick=0.001
Microsoft              bid=0.11  ask=0.13   liq=$357   tick=0.01
OpenAI                 bid=0.35  ask=0.43   liq=$38    tick=0.01
SpaceX                 bid=0.16  ask=0.161  liq=$292   tick=0.001
Right                  bid=0.949 ask=0.999  liq=$166   tick=0.001
Left                   bid=0.94  ask=0.96   liq=$950   tick=0.01
Red                    bid=0.70  ask=0.96   liq=$33    tick=0.01
Blue                   bid=0.59  ask=0.75   liq=$104   tick=0.01
Obsolete               bid=0.04  ask=0.078  liq=$425   tick=0.001
-No Qualifying Event-  bid=0.002 ask=0.04   liq=$178   tick=0.001
```

Verified venue parameters, from the CLOB `/markets/<conditionId>` endpoint and Gamma:

```
minimum_order_size : 5             ← verified on 300/300 markets sampled; its unit is
                                      ambiguously documented, but a $5 notional
                                      satisfies every reading (§8.2, §11 issue 1)
minimum_tick_size  : 0.001 or 0.01 ← varies WITHIN a single event
neg_risk           : false         ← on events sampled; read per event, do not assume
accepting_orders   : true
feesEnabled        : true
feeType            : "mentions_fees"
feeSchedule        : { exponent: 1, rate: 0.04, takerOnly: true, rebateRate: 0.25 }
```

**Fees are enabled on Mentions markets specifically**, taker-only, and we are always a
taker. The charge is

```
fee_per_share = rate × p × (1 − p)        p = filled price, rate = 0.04
```

so it peaks at **1¢/share at p = 0.50** and collapses at both ends:

| p | fee/share | as % of notional |
|---|---|---|
| 0.10 | 0.36¢ | 3.6% |
| 0.30 | 0.84¢ | 2.8% |
| 0.50 | 1.00¢ | 2.0% |
| 0.70 | 0.84¢ | 1.2% |
| 0.95 | 0.19¢ | 0.2% |
| 0.99 | 0.04¢ | 0.04% |

In edge terms the deduction is `0.04 × ask × (1 − ask)` — under a cent everywhere, but a
real bite next to a 7¢ spread. It is close to free for the sniper, which trades at the
top of the range. See §11 issue 2.

Spreads are 1–26 cents, median ~7. Liquidity is $33–$950 per market. Most markets are
count markets ("200+ times"). Every event carries a `-No Qualifying Event-` bracket,
which we never trade.

---

## 3. System shape

One Node process, four long-lived components, one SQLite file per session.

```
        scanner (5 min)  ──►  telegram bot  ──►  watchlist  ──►  supervisor
     listEvents(tagSlug)      /watch, paste URL                  (yt-dlp poll
                                                                  until is_live)
                                                                       │ spawn
                    ┌──────────────────────────────────────────────────┘
                    ▼
     ┌──────────────────────────┐        ┌──────────────────────────────┐
     │  CLOB market stream      │        │  yt-dlp → ffmpeg → ASR (ws)  │
     │  subscribe({'market'})   │        │  partial + final segments    │
     └────────────┬─────────────┘        └───────────────┬──────────────┘
                  └──────────────┬───────────────────────┘
                                 ▼
                     TickStream (merged, coalesced)
                                 │
                 ┌───────────────┴───────────────┐
                 ▼                               ▼
      ┌────────────────────┐         ┌──────────────────────────┐
      │ (A) TermMatcher    │         │ (B) Jev Noul batch       │
      │  deterministic YES │         │  1 request, 1 Noul/market│
      └─────────┬──────────┘         └────────────┬─────────────┘
                └──────────────┬──────────────────┘
                               ▼
                  risk → FAK BUY (@polymarket/client)
                               ▼
                  SQLite journal + user stream fills
```

**Stack.** TypeScript, Node 24 (`@polymarket/client` requires ≥24; `@typesafe-ai/sdk`
requires ≥20), pnpm ≥10. `grammY` for Telegram, `yt-dlp` + `ffmpeg` as subprocesses,
`better-sqlite3` for the journal. Cloud streaming ASR over WebSocket keeps the whole
process in one language.

---

## 4. Discovery

### 4.1 Scanner

Every 5 minutes:

```ts
import { createPublicClient } from '@polymarket/client';
const pm = createPublicClient();

for await (const page of pm.listEvents({
  tagSlug: 'mention-markets',
  closed: false,
  pageSize: 50,
})) { /* diff against seen_events */ }
```

New events produce one Telegram message with title, market count, term list, start/end,
and the `/watch <id>` · `/skip <id>` commands. The scanner does not judge eligibility and
does not call Jev. Watched events are re-polled every 5 min to detect rule changes
(hash of per-market `description` + market set) and closure.

### 4.2 Watchlist

```
/watch <event_id>
  → "Paste the YouTube URL, or /nolive"
  → operator pastes URL
  → `yt-dlp -J --no-download <url>`; bot echoes title / channel / live_status / start
  → bot posts the derived TermSpec table (§6.1) for review
  → /go confirms
```

`/nolive` keeps the event queued without a video; the bot re-prompts 30 min before
`event.startTime`. `WatchlistEntry` is immutable once confirmed:

```
event_id, slug, title, rules_hash
markets[]  { market_id, label, yes_asset_id, no_asset_id, tick_size,
             min_order_size, neg_risk, term_spec, threshold, fee_schedule }
video_id, video_url, channel_id
expected_start, expected_end
confirmed_at, confirmed_by
status  WAITING | LIVE | ENDED | HALTED
```

### 4.3 Supervisor

Poll `yt-dlp -J` every 60 s per `WAITING` entry, every 15 s within ±10 min of the
scheduled start. On `live_status == 'is_live'` → `LIVE`, spawn a session, notify.
On video unavailable/ended → `ENDED`. `/halt [event_id]` blocks new orders immediately;
nothing needs cancelling because no order ever rests.

---

## 5. The session: two streams, one tick

### 5.1 Market stream

Subscribe to every YES **and** NO asset in the event. `1 - bestBid(NO)` is an independent
upper bound on YES and is often tighter than the YES ask in these books.

```ts
const assetIds = entry.markets.flatMap(m => [m.yesAssetId, m.noAssetId]);

const stream = await pm.subscribe([
  { topic: 'market', assetIds, customFeatureEnabled: true },
]);

for await (const ev of stream) {
  switch (ev.type) {
    case 'book':             book.replace(ev); break;  // full snapshot
    case 'price_change':     book.apply(ev);   break;  // level deltas
    case 'best_bid_ask':     book.setBbo(ev);  break;  // needs customFeatureEnabled
    case 'last_trade_price': tape.push(ev);    break;
    case 'tick_size_change': book.setTick(ev); break;
    case 'market_resolved':  session.retire(ev); break;
  }
}
```

`customFeatureEnabled: true` is what enables `best_bid_ask`, `new_market` and
`market_resolved`. The SDK's `ClobMarketWebSocketManager` already owns heartbeat,
reconnect and incremental resubscribe — do not hand-roll the socket.

Also subscribe `{ topic: 'user' }` on the secure client. Fills and positions come from
that stream, never inferred from the POST response.

### 5.2 Transcript stream

```
yt-dlp -f bestaudio -o -  →  ffmpeg -ar 16000 -ac 1 -f s16le pipe:1  →  ASR WebSocket
```

Provider: streaming ASR with interim results (Deepgram `nova-3` or AssemblyAI
Universal-Streaming); `faster-whisper small.en` is the offline/replay fallback.

**TranscriptState:**

- `speculative` — current interim hypothesis, replaced wholesale on each update.
- `confirmed` — append-only, finalized segments, word-level timestamps + confidences.
- `tail(N)` — last N words, the text handed to Jev.
- `counts[market_id]` — from the TermMatcher, over `confirmed` only.

Interim text may inform a Jev forecast. **Only finalized text may increment a count**,
and only finalized text may trigger the sniper.

**Source age** = `now − segment wall-clock` (from the HLS program-date-time), tracked
per tick. This is the number that matters, not ASR round-trip.

### 5.3 The merged tick

```
emit when ANY of:
  - confirmed transcript gained ≥ 1 word
  - speculative transcript changed by ≥ 3 words
  - any watched asset's best bid or ask changed
  - 2 s heartbeat
coalesce: at most one tick per 250 ms
```

```ts
type Tick = {
  seq: number; ts: number;
  cause: 'transcript' | 'book' | 'heartbeat';
  sourceAgeMs: number; elapsedMs: number;
  transcript: TranscriptSnapshot;
  books: Map<AssetId, BookSnapshot>;
};
```

The tick exists so book features and transcript features are always read from one
consistent snapshot. `price_change` on a 34-asset subscription fires far more often than
anything downstream needs.

---

## 6. Strategy A — deterministic YES sniper

This runs first on every tick, ahead of Jev, and needs no model at all.

### 6.1 TermSpec

Derived once at watchlist time from `groupItemTitle` + `description`, reviewed by the
operator in Telegram before `/go`:

```
term_spec = {
  surface_forms : ["Tesla", "Teslas", "Tesla's"],   // case-insensitive, word-boundary
  exclude_forms : [],
  threshold     : 1,            // 20 for "Dude 20+ times"
  speaker_scope : "anyone" | "primary",
  window        : "event"
}
```

### 6.2 The matcher

Over finalized words only, yielding per market: `count_so_far`, `first_hit_ts`,
`last_hit_ts`, `remaining = max(0, threshold − count_so_far)`, and the matched span.

When `remaining` hits 0, the market's YES outcome is **determined** — it will resolve
YES regardless of what happens next. That includes `threshold: 1` markets (the ordinary
"will X be said" case) and count markets alike.

### 6.3 The trade

```
on remaining[market] == 0 and not already sniped[market]:

  require:
    - the hit is in FINALIZED transcript
    - min word confidence over the matched span >= ASR_CONF_MIN   (default 0.80)
    - the hit timestamp is inside the qualifying event window
    - speaker_scope == 'anyone', OR the operator has confirmed the stream carries
      only the qualifying speaker
    - market is not '-No Qualifying Event-'
    - acceptingOrders, not resolved, not halted

  then immediately:
    ask = current best ask on YES
    if ask <= SNIPE_PRICE_CAP (default 0.99):
        FAK BUY, maxPrice = min(SNIPE_PRICE_CAP, ask + SNIPE_SLIPPAGE)
```

**Sizing — the sniper has its own allowance, $20 per market**, separate from the $5
forecast notional. A determined YES is worth exactly 1.00, so the constraint here is
available depth, not conviction:

```ts
const remaining = MAX_SNIPE_PER_MARKET - sniped[market];        // $20 allowance
const affordable = depthAtOrBelow(book, maxPrice);              // USDC at ≤ maxPrice
const amount = Math.min(remaining, affordable);
if (amount < minNotionalFor(maxPrice)) return;                  // §8.2
```

One FAK sweep takes everything resting at or below `maxPrice`, up to the allowance. The
venue minimum never binds here: $20 at a 0.99 cap is ~20 shares against a 5-share floor.

This is a latency race against anyone else watching the same feed,
and §11 issue 4 explains why we are 15–40 s behind the room — but in books this thin
the other side of a stale 0.30 ask is frequently a resting order nobody has repriced,
not a faster competitor. Expected hit rate is the main unknown and M3 measures it.

**The asymmetry that makes this the right thing to ship first:** at an ask of 0.95–0.99
the `mentions_fees` charge is ~0.02–0.04¢/share (§11 issue 2), there is no forecasting
error, and the only way to lose is an ASR false positive or a rules misreading. Both are
addressable by the guards above. Strategy B has to beat a 7-cent spread *and* a fee
*and* be well calibrated.

**Re-arming.** If the sweep fills partially and the ask is still ≤ cap after
`SNIPE_COOLDOWN` (default 5 s), re-fire for the unused allowance, up to
`MAX_SNIPE_ORDERS_PER_MARKET` (default 5). Topping up is clearly worth it here: the
position is worth 1.00 at resolution, so any share bought under the cap is profit. Stop
as soon as the allowance is exhausted or the ask clears the cap.

---

## 7. Strategy B — Jev forecast

### 7.1 What Jev is, and what that forces

Jev is TypeSafe's System One model (`jev-latest` → `jev-1.13.0`), reached at
`POST https://api.typesafe.ai/v1/systemone` or via `@typesafe-ai/sdk`. It returns
**typed judgments with calibrated probabilities, not text**. We use **Noul** questions:
each returns a single number in [0, 1], the probability that the answer is yes. There is
no `confidence` field on a Noul and no reasoning trace — the number is the answer and
the certainty in one.

Relevant published constraints and failure modes (`/models`, `/model-jaggedness/jev-1.13`):

| Property | Value | What it forces here |
|---|---|---|
| Price | $0.042 / Mtok input, output free | Cost is ~irrelevant. A 6k-token call ≈ $0.00025. |
| Rate limit | 250k tok/s, 1200 req/min | Not a binding constraint at one call per ~5 s. |
| Context | 64k total; 32k for state + longest question | Transcript tail is comfortably within budget. |
| Parallel questions | State ingested once, all questions evaluated in parallel | **One request per tick covering all markets.** Adding Nouls barely changes latency. |
| **Cannot count** | Documented failure mode | TermMatcher is mandatory, not an optimization. |
| **Bad at math/numbers** | Documented failure mode | Keep all arithmetic in code. |
| **Bad at date/time comparison** | Documented failure mode | Pass pre-computed, phrased durations. |
| **Context rot** | Accuracy falls with irrelevant state | Send only what the question needs. |
| Literal reading | Answers the question as written | Instructions must state the exact condition. |

### 7.2 Deviation from the brief, and why

The original request was to give Jev "BBO, BBO recent changes (klines, moving averages),
market liquidity" at each tick. **This plan computes all of those and does not send them
to Jev.** Three of the vendor's nine documented failure modes are numeric — arithmetic,
numeric representations, and large state full of irrelevant detail — and a table of
OHLC bars and moving averages is exactly that. On a model explicitly described as
"not a calculator" with "context rot", it is likely to cost accuracy on the one judgment
we actually need.

So the split is:

- **Jev answers one semantic question per market:** will this term be spoken?
- **Code owns everything numeric:** counts, elapsed/remaining time, BBO, spread, depth,
  klines, moving averages, edge, fees, thresholds, sizing.

All the microstructure features are still computed and journaled every tick — they feed
the §8 decision rule and the replay driver. They are just not model input.

**Testable A/B, since this deviates from what was asked.** Jev's docs note it does better
on semantic representations than numeric ones ("hex values underperform English colour
names"), so if market awareness is worth having, it should arrive as a phrase, not a
number. Variant B2 adds one field to the state:

```json
"market_view": "traders currently price this as unlikely"   // bucketed in code
```

buckets: `very unlikely` <0.10, `unlikely` <0.30, `uncertain` <0.60, `likely` <0.85,
`very likely` ≥0.85. Run B1 (price-blind) and B2 (bucketed) on identical ticks from the
journal and compare Brier score and realized edge. The comparison is nearly free and
settles the question with data. Until it does, **B1 is the live path** — the research doc's
original reasoning (a price-aware forecast anchors to the ask and the measured edge
collapses toward zero) still stands, and now has a second, model-specific reason behind it.

### 7.3 The request

One request per gated tick. State is semantic only:

```jsonc
{
  "model": "jev-latest",
  "state": {
    "event": "JD Vance campaign rally in North Carolina, broadcast live",
    "speaker": "JD Vance",
    "resolution_basis": "A market resolves yes if the listed term is spoken aloud by anyone during this event.",
    "stage": "about two thirds through; roughly twenty minutes of speech remain",
    "earlier_summary": "<rolling ~200-word summary of speech before the tail>",
    "recent_transcript": "<verbatim last ~1000 words, finalized + interim>"
  },
  "questions": {
    "m_4643455": {
      "type": "noul",
      "instructions": {
        "term": "Tesla",
        "also_counts": ["Teslas", "Tesla's"],
        "times_said_so_far": 0,
        "question": "Will the speaker say `term` (or any of `also_counts`) at least once more before this event ends?"
      }
    },
    "m_4643461": {
      "type": "noul",
      "instructions": {
        "term": "Dude",
        "times_said_so_far": 14,
        "times_still_needed": 6,
        "pace_so_far": "said roughly once every three minutes so far",
        "question": "Will the speaker say `term` at least `times_still_needed` more times before this event ends?"
      },
      "criteria": {
        "true": "The speaker uses the word that many more times or more before the event ends",
        "false": "The speaker uses it fewer than that many more times before the event ends"
      }
    }
  }
}
```

Response:

```json
{ "model": "jev-1.13.0",
  "answers": { "m_4643455": { "type": "noul", "noul": 0.55 },
               "m_4643461": { "type": "noul", "noul": 0.31 } },
  "usage": { "input_tokens": 5840, "output_tokens": 46 } }
```

Notes on the shape, all following published guidance:

- **Question ids carry the market id.** Ids are not sent to the model; they are how code
  reassembles answers. Same pattern as the duplicate-detection cookbook.
- **Structured `instructions`**, with the fixed question text and the per-market data in
  named fields referenced by backticked path.
- **The deterministic count goes into the question.** `times_said_so_far` is the
  TermMatcher's tally over the finalized transcript, and `times_still_needed` is
  `threshold − times_said_so_far`, both computed in code. Jev never counts and never
  subtracts — it only judges whether the remaining occurrences will happen. Passing the
  count as well as the remainder is deliberate: the tally is the evidence for how the
  speaker is actually using the word, which is the substance of the judgment on a count
  market, and it is useful context even on a `threshold: 1` market where it is 0.
- **`pace_so_far` is a phrase, not a rate.** Code does the division and hands over
  English, for the same reason `stage` is phrased rather than timestamped. Omitted when
  `times_said_so_far` is 0.
- **`stage` is a phrase, not a timestamp.** Code computes elapsed/remaining; Jev reads
  English.
- **Phrased so a high value means yes**, per the Noul writing guidance.
- **Markets the count already resolves are excluded from the request entirely.** Once
  `times_said_so_far >= threshold` the outcome is determined, Strategy A owns it, and
  asking Jev would waste tokens and invite an answer that contradicts a known fact.
- Markets whose `times_still_needed` can no longer plausibly be reached (e.g. "20+ times",
  3 said, 40 seconds left) are also dropped; that is a code judgment, not a Jev one.

Count-market Nouls will be the weakest part of this. "At least 6 more times" is a rate
question wearing semantic clothes, and Jev is documented as weak on exactly that. M4
therefore ships a code-side Poisson baseline from the observed rate and compares it
against Jev's Noul on the same ticks, before either is trusted for sizing.

### 7.4 The call gate

Cost is negligible and the rate limit is far away, so the gate exists only to bound
latency and avoid stacking in-flight requests:

```
call when ALL of:
  - no call in flight for this event
  - >= MIN_INTERVAL (default 5 s) since the last call returned
  - source_age < MAX_SOURCE_AGE (default 45 s)
  - at least one market is still unresolved and reachable
and ANY of:
  - >= 30 new confirmed words since the last call
  - any unresolved market's best ask moved >= 2 ticks
  - a TermMatcher count changed
  - >= FORCE_INTERVAL (default 30 s) since the last call
```

Each answer is stamped with the tick `seq` it came from. Execution re-reads the live book
and discards any forecast older than `FORECAST_TTL` (default 20 s).

`MIN_INTERVAL` is a placeholder: **Jev's per-request latency is not published and must be
measured in M0.** If it lands under a second, drop `MIN_INTERVAL` toward 2 s and raise the
call rate — at $0.042/Mtok there is no reason not to.

---

## 8. Signal, sizing, execution

### 8.1 Strategy B decision rule

```
p     = answers["m_<id>"].noul
ask   = live best ask on YES
fee   = 0.04 * ask * (1 - ask)         // per share, taker-only; §2
edge  = p - ask - fee

trade iff:
  edge >= MIN_EDGE                          (default 0.10)
  edge >= 0.5 * spread                      (must clear the spread, not just the mid)
  PRICE_FLOOR <= ask <= PRICE_CEIL          (default 0.05 .. 0.90, see §8.2)
  depth at or below maxPrice >= notional    (the fill actually exists)
  position[market] + notional <= MAX_B_PER_MARKET
  exposure[event]  + notional <= MAX_PER_EVENT
  now - last_order[market] >= ORDER_COOLDOWN  (default 60 s)
  market unresolved, reachable, acceptingOrders, not halted
```

### 8.2 Sizing

**Strategy B: constant $5 per order.** Strategy A: its own $20-per-market allowance
(§6.3).

There appear to be **two independent minimums**, and which one binds a marketable FAK buy
is not settled publicly (§11 issue 1):

```
(a) notional >= $1         a minimum USDC notional, reported to apply via the API
(b) shares   >= 5          the market's `minimum_order_size`, enforced in share units
```

**$5 clears both at every tradeable price, so the ambiguity never binds.** Rule (b) costs
`5 × p`, which is below $5 for any `p < 1.00`:

| ask | $5 buys | ≥ 5 shares? | ≥ $1? |
|---|---|---|---|
| 0.10 | 50.0 | ✓ | ✓ |
| 0.50 | 10.0 | ✓ | ✓ |
| 0.90 | 5.56 | ✓ | ✓ |
| 0.99 | 5.05 | ✓ | ✓ |

$5 is in fact the smallest constant notional with that property, which is a good reason to
prefer it over a dynamic rule: no config flag, no branch, no dependency on an unresolved
documentation question.

```ts
// Strategy B — constant, valid at every price
const notional = 5;

// Strategy A — allowance-driven; $20 also clears both rules everywhere
const amount = Math.min(MAX_SNIPE_PER_MARKET - sniped[market],
                        depthAtOrBelow(book, maxPrice));
```

`PRICE_CEIL` therefore reverts to a pure strategy parameter, set at **0.90**. It is nearly
decorative: with `MIN_EDGE` at 0.12, an ask of 0.90 already requires `p = 1.02` to clear
the rule, so the band above ~0.85 is unreachable on edge grounds alone. Above that range
a mention market is near-settled and the sniper is the right instrument.

The trade-off $5 buys: each forecast order now risks $5 instead of $3, so the per-market
and per-event caps in §9 are scaled to hold total exposure roughly where it was.

### 8.3 Placement

```ts
import { createSecureClient, OrderSide, OrderType } from '@polymarket/client';
import { privateKey } from '@polymarket/client/viem';

const trader = await createSecureClient({
  wallet: process.env.POLYMARKET_DEPOSIT_WALLET,
  signer: privateKey(process.env.POLYMARKET_PRIVATE_KEY),
});

const maxPrice = roundToTick(Math.min(cap, ask + SLIPPAGE), market.tickSize);

const est = await trader.estimateMarketPrice({
  assetId, side: OrderSide.BUY, amount: notional, orderType: OrderType.FAK,
});
if (est > maxPrice) return;              // book moved between tick and decision

const order = await trader.placeMarketOrder({
  assetId,
  side: OrderSide.BUY,
  amount: notional,          // USDC notional for a BUY — SDK semantics
  orderType: OrderType.FAK,  // immediate, partial fills OK, never rests
  maxPrice,
});
```

`OrderType.FAK` is exactly the requested behaviour. `maxPrice` is the slippage cap and
**must be rounded to that market's tick** — 0.001 and 0.01 both occur inside one event.

For Strategy A, skip the `estimateMarketPrice` round-trip: it costs 50–200 ms on a trade
whose whole value is speed, and `maxPrice` already bounds the downside.

### 8.4 Exits

None. Every position is held to UMA resolution, typically 1–3 days after the event.

---

## 9. Risk

No new order when any of:

- no confirmed `WatchlistEntry`, or `rules_hash` changed since confirmation
- video not live, or `video_id`/`channel_id` no longer matches the binding
- `source_age > MAX_SOURCE_AGE` — the audio is stale and you are trading blind
- forecast older than `FORECAST_TTL` (Strategy B only)
- ASR socket down, or Jev errored / timed out / returned a malformed answer
- market resolved, closed, `acceptingOrders == false`, or unreachable
- `-No Qualifying Event-` market
- `MAX_B_PER_MARKET` / `MAX_SNIPE_PER_MARKET`, `MAX_PER_EVENT`, or `MAX_DAILY_NOTIONAL` reached
- global or per-event `/halt`

Opening defaults, given live-from-day-one:

```
Strategy B (forecast)
  NOTIONAL              $5        constant, valid at every price (§8.2)
  PRICE_FLOOR/CEIL      0.05 / 0.90
  MIN_EDGE              0.12
  MAX_B_PER_MARKET      $15       (3 orders)
  ORDER_COOLDOWN        60 s

Strategy A (sniper)
  MAX_SNIPE_PER_MARKET  $20
  SNIPE_PRICE_CAP       0.99
  SNIPE_SLIPPAGE        0.01
  SNIPE_COOLDOWN        5 s
  MAX_SNIPE_ORDERS_PER_MARKET  5
  ASR_CONF_MIN          0.80

Shared
  MAX_PER_EVENT         $120
  MAX_DAILY_NOTIONAL    $250
```

The two strategies draw on separate per-market allowances but share `MAX_PER_EVENT` and
`MAX_DAILY_NOTIONAL`. A single event where several terms land could consume the event cap
on sniper fills alone — that is the correct priority, since those are the determined
outcomes.

Streams and journaling continue while trading is suspended. A scanner failure must never
disturb a running session.

---

## 10. Milestones

Live from the start, so each milestone adds capability behind its own limit rather than
gating on a shadow period.

**M0 — Wallet and venue facts (0.5 d).** Funded Polygon deposit wallet, signature type,
allowances. Then settle the two open venue questions empirically, with real orders on any
liquid market — total cost under $20, and it determines config that everything downstream
depends on.

*The sizing sanity check.* One $5 FAK BUY at a high ask (~0.90) and one at a low ask
(~0.15). Both should fill; $5 is above every candidate minimum at both ends (§8.2). This
is confirmation, not a config fork — nothing downstream branches on the result, so it does
not block M1. If the high-ask order is rejected anyway, capture the verbatim error: it
would mean a third rule exists that none of the documentation describes.

*The fee probe (§11 issue 2).* Reconcile the low-ask fill's `fee_charged` against
`0.04 × p × (1 − p) × shares`. Use the low-ask order because the fee there is ~0.5¢/share
and therefore actually measurable; at 0.90 it rounds to almost nothing. If the numbers
disagree, the gap is `rebateRate: 0.25`, which the formula does not account for.

Also measure Jev round-trip latency with a 20-Noul request over a ~5k-token state, to set
`MIN_INTERVAL` (§7.4).

**M1 — Discovery (2–3 d).** Scanner, Telegram bot, watchlist, TermSpec review, supervisor.
Gate: a real event goes from notification to a `LIVE` session with no code change.

**M2 — Streams, ticks, counter (3–4 d).** CLOB subscription, BookState + features,
yt-dlp→ffmpeg→ASR, TranscriptState, TermMatcher, merged ticks, full journaling. No orders.
Gate: a full PMQs or JRE session end to end; source age under 30 s; TermMatcher counts
agree with a human review of the recording.

**M3 — Strategy A live (1–2 d).** Sniper only, $20 per market, `MAX_PER_EVENT` $120.
Gate: no ASR false-positive fills across 3 sessions; measure how often the ask is still
below cap when a detection lands, and at what price — that distribution is the strategy,
and it also settles Q1.

**M4 — Strategy B live (3–4 d).** Jev Noul batch, decision rule, $5 constant, B1
price-blind live.
Journal B2 and the Poisson baseline alongside without trading them. Gate after 5 sessions:
B1's Brier score beats both the market mid and a base-rate baseline, and realized edge
survives spread plus fee. If it does not, Strategy A stands alone and B is reworked.

**M5 — Replay and tuning.** Offline driver re-drives sessions from the journal with no
network, for prompt changes, threshold sweeps, and the B1/B2/Poisson comparison.

---

## 11. Issues

**1. The order minimum is genuinely ambiguous, and nobody has documented it correctly.**
`minimum_order_size: 5` is verified on 300/300 markets sampled from
`clob.polymarket.com/sampling-markets` — it is a global constant, not a Mentions quirk.
What the `5` *counts* is unresolved, and Polymarket's own documentation says both things:

| Source | Says |
|---|---|
| `docs.polymarket.com/market-data/market-details` | "minimum USDC **notional**; orders smaller than this are rejected" |
| `docs.polymarket.com/trading/place-orders` | "`min_order_size` is the minimum number of **shares** the CLOB accepts" |
| CLOB rejection text (py-clob-client #301) | `Size (1.08) lower than the minimum: 5` — compared in **share** units |
| ts-sdk source | Carries the field with no unit annotation; `create-market-order.ts` passes it straight into a BUY `amount` (i.e. as dollars) |
| py-sdk issue #302 | Open and unanswered, asking exactly this, including whether a separate notional minimum applies to marketable FOK/FAK orders |

There is also credible evidence of a **separate $1 notional minimum**: the #301 reporter
ran ~$1.05 trades where most filled and only some were rejected, which is the signature of
two independent checks rather than one. That is consistent with the common understanding
that the API enforces a $1 notional floor, likely on marketable orders, alongside the
5-share floor on resting ones.

**This no longer affects us.** Both the $5 forecast notional and the $20 sniper allowance
clear every candidate rule at every price (§8.2), so the plan does not need the answer.
Recorded here because it is a live trap for anyone sizing below $5 — and because if
Polymarket ever raises `minimum_order_size` above 5, the $5 constant silently stops
clearing the share rule at high prices. Worth a startup assertion: refuse to trade a
market whose `minimum_order_size × ask > NOTIONAL`.

**2. Mentions markets charge a taker fee, and we are always the taker.**
`feeType: "mentions_fees"`, `{exponent: 1, rate: 0.04, takerOnly: true, rebateRate: 0.25}`,
with `fee_per_share = rate × p × (1 − p)` — max 1¢/share at p = 0.50, ~0.04¢/share at
p = 0.99. In the tradeable 0.05–0.90 band it runs 0.2–1.0¢/share, so it shaves under a
cent off the edge: modest on its own, but it stacks on a ~7¢ spread. The sniper trades at
the flat end of the curve and pays almost nothing. The ts-sdk carries the `FeeSchedule`
schema without implementing the formula, so M0 still reconciles a real `fee_charged`
against the expected value — mainly to pin down what `rebateRate: 0.25` does, which the
formula above does not account for.

**3. The spread is the binding constraint on Strategy B, not slippage or fees.** Median
spread ~7¢. A 0.12 edge threshold against a 7¢ spread plus ~0.8¢ of fee means the true
requirement is ~16¢ of mispricing from Jev. That is a lot to ask. M4's gate is where this
gets answered, and it is the main reason the sniper ships first.

**4. You are 15–40 s behind the room.** YouTube HLS ships ~6 s segments and buffers 2–3;
yt-dlp adds a little; ASR finalization adds 1–3 s. Anyone watching the broadcast directly
beats you to a term that was just spoken. This is why `source_age` is a kill switch rather
than a metric, and why Strategy A's realized hit rate is genuinely uncertain until M3
measures it.

**5. The resolution source is the event's audio, not your YouTube stream.** The rules say
"the resolution source will be audio of the event". Your feed may be a re-broadcast,
translated, delayed, or carry commentary the official feed does not. An ASR hit on a
pre-show commentator saying "Tesla" is a false sniper trigger. The `speaker_scope` guard
and operator confirmation are the only defences.

**6. Jev is documented as unable to count and weak at arithmetic and dates.** This is why
§6 is deterministic code and §7.3 pre-computes `times_still_needed` and phrases `stage`
in English. It is also why the requested numeric market features are not sent to the model
(§7.2). Flagging explicitly because it changes what was asked for.

**7. Count markets are the weakest case for Jev.** They are roughly half the universe and
they are rate questions, which is the documented weak spot. Mitigated by the code-side
Poisson baseline in M4, but expect Strategy B to end up restricted to `threshold: 1`
markets if the comparison goes badly.

**8. TermSpecs are hand-derived and silently corrupt everything if wrong.** "Tesla" vs
"Teslas" vs "Tesla's", "Fuck / Fucking" as one market, acronyms, homophones, and
"by anyone" vs "by the speaker" all come from prose plus a linked PDF. Operator review
before `/go` is the only safeguard, and a wrong spec poisons both strategies at once.

**9. Mixed tick sizes inside one event.** 0.001 and 0.01 coexist. `maxPrice` must be
rounded per market or the order is rejected.

**10. Capital lockup.** No exits means every filled dollar is locked until UMA resolves.
At `MAX_PER_EVENT` $60 and two concurrent sessions that is $120 unavailable for a few
days — small at these sizes, but it scales linearly with any size increase.

**11. `neg_risk` is false on the events sampled but must be read per event.** A neg-risk
event changes exchange address and order construction.

**12. Jev latency is unpublished.** The §7.4 gate assumes low single-digit seconds. M0
measures it; the gate constants are written to be tuned, not guessed once.

---

## 12. Journal

One SQLite file per session:

```
ticks       (seq, ts, cause, source_age_ms, transcript_hash, books_json, features_json)
transcript  (seq, kind{partial,final}, t_start, t_end, text, word_confidences)
counts      (tick_seq, market_id, count, remaining, first_hit_ts, matched_span)
jev_calls   (id, tick_seq, model_returned, request_json, answers_json, latency_ms, usage, ok)
decisions   (id, strategy{A,B}, tick_seq, jev_call_id, market_id, p, ask, spread,
             fee_est, edge, notional, max_price, action, reject_reason)
orders      (id, decision_id, asset_id, amount, max_price, response_json)
fills       (order_id, price, size, fee_charged, ts, source{user_stream})
```

`fills.fee_charged` is what verifies issue 2. Audio is archived per session (~60 MB/hour)
so ASR providers can be re-compared offline. Replay must re-drive the whole strategy from
the journal with no network.

---

## 13. Remaining questions

**Q1 — `SNIPE_PRICE_CAP` at 0.99.** Kept as specified. Worth noting that a fill at 0.99
returns 1% gross over 1–3 days of lockup, and consumes $20 of a $120 event cap to make
$0.20. Most of the value in this path is catching stale asks well below the cap, so a
lower cap (~0.90) would barely reduce expected profit while freeing the allowance for
better fills in the same event. Left at 0.99 pending M3's distribution of actual snipe
prices.

**Q2 — ASR provider.** Deepgram assumed for latency. Local `faster-whisper` keeps audio
off third-party services at the cost of ~2–4 s and a GPU.

**Q3 — Operator.** Single Telegram user assumed. A group chat changes who may `/go` and
`/halt`.

**Q4 — If M4's gate fails**, is Strategy A alone an acceptable product, or does the
project need the Jev forecast to work?
