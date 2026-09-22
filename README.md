# Foreteller

Foreteller runs one manually selected Polymarket mention event from a confirmed
YouTube live feed. It transcribes the feed, detects reviewed terms, requests
price-blind Jev forecasts, and routes both strategies through one bounded,
restart-safe FAK executor.

## Requirements

- Node.js 24 and pnpm 10
- `yt-dlp` and `ffmpeg` on `PATH`
- Telegram, Deepgram, and TypeSafe credentials
- Polymarket wallet credentials only for live trading

Copy `.env.example` to `.env`, fill in the required values, then run:

```sh
pnpm install
pnpm run doctor
pnpm dev
```

The service defaults to dry run. Set `LIVE_TRADING=true` only after `pnpm doctor`
passes and the wallet has the required balance and allowances.

## Operator flow

```text
/watch <event_id> <youtube_url> <speaker name>
/go
/status
/halt
```

`/watch` proposes only simple single-mention markets with an unambiguous
`groupItemTitle`, a valid qualifying window, and complete venue metadata. `/go`
re-fetches the event and rejects changed rules before it persists the binding.
One session can run at a time.

The Deepgram speaker number defaults to `0`; override
`DEEPGRAM_PRIMARY_SPEAKER` when the confirmed direct feed labels the primary
speaker differently. Commentary and translated feeds should not be used.

## Audit and recovery

SQLite is the authoritative journal. Order intents reserve persistent daily,
event, strategy, and wallet capacity before submission. A timed-out submission
stays unknown and blocks later orders until venue reconciliation succeeds.

Audio is archived as FLAC under `SESSION_DATA_DIR/<session_id>/`. Reports and
offline replay use only stored facts:

```sh
pnpm run report -- [session_id]
pnpm run replay -- [session_id]
```

The YouTube/ffmpeg pipe does not expose trustworthy HLS program timestamps.
When that timestamp is unavailable, the recorded age is explicitly labeled
`pipeline_clock`: it measures local ingest and transcription delay but excludes
upstream YouTube latency. The 45-second age limit still applies, and live order
submission remains disabled unless `LIVE_TRADING=true`.
