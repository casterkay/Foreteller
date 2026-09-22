# Foreteller MVP Plan

Status: proposed implementation plan

Updated: 2026-09-22

This is the authoritative MVP plan. `jev-live-mention-market-strategy.md` is
background research; its architecture, scope, and delivery gates are superseded.

## Goal and scope

Run one manually selected Polymarket mention event from a confirmed YouTube live
stream through transcription, signals, bounded live orders, and a session report.

Keep both strategies:

- **A — Mention sniper:** buy YES after a qualifying mention is detected.
- **B — Jev forecast:** buy YES when the forecast exceeds executable cost by the
  configured margin.

Start with English, single-mention markets (`threshold = 1`), one active event,
one Telegram operator, and Deepgram streaming ASR. The operator supplies the event
and video, reviews the term rules, and confirms the qualifying speaker and window.
Skip ambiguous rules, commentary/translated feeds, and `-No Qualifying Event-`.

Orders are FAK BUY only: partial fills are allowed, nothing rests, and positions
are held to resolution. Live trading starts when M3 is ready; there is no separate
multi-session shadow gate.

## Build shape

One TypeScript / Node 24 process, pnpm, and one SQLite database across sessions.
Use `@polymarket/client`, `@typesafe-ai/sdk`, `grammY`, `better-sqlite3`,
`yt-dlp`, and `ffmpeg`. Verify installed SDK interfaces during M0.

```text
Telegram: event + YouTube URL + reviewed rules
                     ↓
        session runner + live-start polling
                     ↓
     CLOB books + audio → Deepgram transcript
                     ↓
           term matcher + Jev batch
                     ↓
       shared risk checks → FAK execution
                     ↓
          SQLite journal + session report
```

## Fixed starting limits

Keep these in one configuration module. All spending limits include filled
notional plus reserved notional for pending or unknown orders. Reserve wallet
capacity for fees as well. Strategy allowances are separate; event and daily
limits are shared. Daily spend uses UTC and persists across restarts.

| Setting | Default |
|---|---:|
| Forecast order notional | $5 |
| Forecast allowance per market | $15 |
| Forecast minimum edge, after fees | 0.12 per share |
| Forecast ask range | 0.05–0.90 |
| Forecast order cooldown | 60 seconds |
| Sniper allowance per market | $20 |
| Sniper maximum price | 0.99 |
| Sniper slippage allowance | 0.01 |
| Sniper retry cooldown / maximum attempts | 5 seconds / 5 |
| Minimum ASR word confidence for a hit | 0.80 |
| Shared event / daily notional limits | $120 / $250 |
| Maximum source age | 45 seconds |
| Maximum forecast age, from input snapshot | 20 seconds |
| Minimum interval between Jev calls | 5 seconds after completion |

The sniper is fallible: finalized ASR and confidence scores do not guarantee a
qualifying mention or YES resolution. At 0.99, one losing trade erases roughly
99 equal-sized winning trades before fees. Record the evidence for every hit.

## Milestones and tasks

Complete M0–M5 in order. Estimates are implementation days and exclude waiting for
suitable live events or market resolution. Check tasks off only with evidence.

### M0 — Runnable foundation (1 day)

- [ ] Initialize TypeScript, pnpm scripts (`dev`, `build`, `test`), and `.env.example`.
- [ ] Validate configuration, operator ID, credentials, and required binaries at startup.
- [ ] Connect to Polymarket and Jev; fetch one event's rules, token IDs, tick sizes,
      order minimums, fee schedule, and `neg_risk` setting.
- [ ] Check wallet identity, balance, and allowances; report missing prerequisites.
- [ ] Send a representative Jev Noul batch and record latency and returned model version.
- [ ] Create SQLite tables for sessions, bindings, transcripts, books/ticks, forecasts,
      decisions, order intents, fills, and outcomes. Keep credentials out of logs.

**Done when:** a fresh checkout builds, runs a connection check, and writes a
sample session to SQLite. No order submission is needed for this milestone.

### M1 — Start and control one event (1–2 days)

- [ ] Implement `/watch <event_id> <youtube_url>` for the allowlisted Telegram user.
- [ ] Fetch video metadata and show event, channel, selected markets, and qualifying window.
- [ ] Load an operator-authored TermSpec for each market: accepted forms, exclusions,
      word boundaries, speaker scope, and qualifying window. Present it for review.
- [ ] Implement `/go`, `/status`, and `/halt`; persist confirmation and the rules hash.
- [ ] Poll for live start; allow only one active session. Recheck watched rules and closure.
- [ ] Halt on changed rules, invalid binding, lost source, or event end. Require renewed
      confirmation for a changed binding; allow manual halt if the event ends before the video.

**Done when:** the operator can configure, confirm, start, inspect, and halt a
session without changing code. Unauthorized Telegram commands have no effect.

### M2 — Reliable books and transcript (2–3 days)

- [ ] Subscribe to selected YES/NO books; apply snapshots, deltas, and tick-size changes.
      Use the SDK's reconnect support; require fresh snapshots before trading resumes.
- [ ] Pipe YouTube audio through ffmpeg into Deepgram; keep interim and final text separate.
- [ ] Preserve source timestamps through ingestion and measure audio age. Unknown age
      blocks trading, as do disconnected or unsynchronized market data.
- [ ] Match finalized words only, including phrases across segment boundaries. Deduplicate
      segments after reconnects so replayed audio cannot create a second hit.
- [ ] Merge transcript and book updates into consistent snapshots, at most every 250 ms.
- [ ] Journal snapshots and matched spans; archive audio for review and replay.
- [ ] Test accepted/excluded forms, segment boundaries, duplicate segments, speaker/window
      rejection, and stale-source handling using short recordings and fixtures.

**Done when:** a recorded qualifying speech produces human-verified hits, and a
live stream produces timestamped books and transcript. Reconnects neither duplicate
hits nor permit decisions on unavailable data.

### M3 — Shared execution and live sniper (2–3 days)

- [ ] Implement one serialized executor shared by both strategies. Check halt state,
      source health, current market status, minimum size, wallet capacity, and spending caps.
- [ ] Persist an order intent and reserve its budget atomically before submission.
      Keep pending/unknown orders reserved; never blindly retry a timed-out submission.
- [ ] Implement FAK BUY with a maximum price rounded down to the market's tick size.
      Size the sniper by remaining allowance and available depth; skip sub-minimum orders.
- [ ] Deduplicate user-stream fills by venue identity. Reconcile orders and trades through
      the venue API after disconnects, timeouts, and startup before enabling new orders.
- [ ] Trigger Strategy A on a qualifying final hit. Top up only after the previous order
      is reconciled, within the cooldown, attempt limit, and remaining allowance.
- [ ] Test partial fills, delayed/duplicate fills, unknown submission results, restart,
      shared-cap contention, and halt during a pending order.
- [ ] Run bounded live execution checks, including $5 orders at low/high prices where
      suitable markets exist. Keep probe notional below $20 and inside shared caps.
      Verify minimum-size behavior and actual fees on a Mentions market; resolve any
      fee discrepancy before relying on the fee estimate.

**Done when:** live orders reconcile to the venue, spending caps survive failures
and restart, and every sniper decision has a recorded audio span and accept/reject
reason. A halt prevents further submissions while existing orders still reconcile.

### M4 — Live Jev forecast (1–2 days)

- [ ] Send one price-blind Noul batch for unmatched markets, using event rules, speaker,
      recent transcript, and event stage. Record request, answer, model version, and latency.
- [ ] Allow one request in flight. Trigger on new transcript or meaningful book changes,
      with a 30-second fallback call and the configured minimum interval.
- [ ] Reject malformed, timed-out, or stale forecasts; recheck mention state and the live
      book before execution. Jev failure disables B while A can continue if its inputs are healthy.
- [ ] Compute expected execution cost for the full $5 from available depth and per-fill
      fees. Require `probability - cost_per_share >= 0.12`; also constrain `maxPrice`
      so a worse fill cannot violate that margin. Skip insufficient depth.
- [ ] Route B through the same executor, with its own $15 allowance and 60-second cooldown.
      Give A first access to available budget when both signal on the same snapshot.
- [ ] Test stale responses, already-matched terms, shallow books, and simultaneous A/B signals.

**Done when:** both strategies run in one session, share spending limits correctly,
and every forecast order can be explained from its recorded inputs and executable cost.

### M5 — End-to-end session and minimal replay (1–2 days)

- [ ] Run one complete qualifying live event with both strategies enabled. Record skipped
      opportunities as well as orders; do not force trades to satisfy a milestone.
- [ ] Produce a report by strategy: detections, decisions, fills, spend, fees, source age,
      forecast latency, and execution errors. Review every sniper fill against the audio.
- [ ] Reconcile all orders after the event. Fetch final outcomes later and report realized
      P&L only for resolved positions; show unresolved exposure separately.
- [ ] Add a local replay command using stored snapshots and stored Jev responses, with
      no network or order submission. Reproduce the session's signals and risk decisions.
- [ ] Document setup, event preparation, start, halt, restart/recovery, and report commands.

**Done when:** one session is fully auditable, replay reproduces its decisions, and
all orders are reconciled. Correct operation completes the MVP; it does not prove
profitability. Review results across subsequent events before tuning or raising limits.

## After the MVP

- Automatic Mentions discovery, Telegram notifications, and a multi-event watchlist.
- Count markets and a Poisson baseline.
- B2 market-aware prompts, calibration experiments, and parameter sweeps.
- Extra ASR providers, local transcription, and unused market indicators.

Keep the first release focused on one event, correct evidence, bounded execution,
and an understandable result.
