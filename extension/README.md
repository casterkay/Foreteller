# Foreteller browser extension

1. Start the local panel service with `pnpm panel`.
2. Open `chrome://extensions`, enable Developer mode, and choose **Load unpacked**.
3. Select this `extension` directory.
4. Open a live YouTube watch page and configure Foreteller in the right sidebar.

The extension contains no API keys. It talks only to the Foreteller service bound to
`127.0.0.1:4318`.
If `PANEL_SERVER_PORT` changes, enter the same port in the panel settings.

### Live updates

Every distinct transcript revision (interim or finalized) starts one Jev request,
with all unresolved terms batched together. Revised interim speech replaces the
previous hypothesis. `TRANSCRIPT_MAXIMUM_WORDS` controls the retained suffix
(default: 1,000 whitespace-separated words). Price updates and timers never trigger
inference. Requests overlap without a cooldown; older responses cannot replace a
newer forecast. Existing request timeouts and forecast-age checks still apply.

The service pushes panel state over a WebSocket through the extension worker.
Reconnects restore the current snapshot; up to five retries use exponential
backoff, after which the panel asks for a page reload. API failures are visible in
the panel. Reload the extension and restart the panel service after upgrading.

At $0.042 per million input tokens (Jev 1.13), 3,000 input tokens per revision cost
about $0.45/hour at one revision per second or $0.91/hour at two. The transcript is
shared across term questions; actual cost depends on question count and cadence.
