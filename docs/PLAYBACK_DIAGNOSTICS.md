# Playback diagnostics

## Playback incidents

The authenticated `POST /api/streaming/v1/client-metrics` endpoint accepts player
signals. Incident events are written through the `Playback.Diagnostic` logger at
`warn` level, independently of `STREAMING_TRACE_LOGS`. The existing metrics remain
available. Incident lines contain a JSON object with `event`, authenticated
`userId`, server `receivedAtMs`, and bounded `fields`. Queued events also include
`eventId` and client `observedAtMs`; client clocks are not authoritative.

The fields include recording/session identity, source, playback position,
contiguous buffered seconds, playing state, browser visibility, coarse browser/OS
family, reported network availability, error category/code and recovery stage.
`visibility=hidden` means the document is in the background; it does not prove the
phone is locked. `online=true` does not prove that an upstream provider is reachable.
Raw error messages, source URLs, headers, credentials and arbitrary client fields
are excluded from incident logs and the browser outbox.

`player.recovery_attempt` records a scheduled same-track retry,
`player.recovery_ready` records a correlated loaded stream, and
`player.recovery_resumed` requires advancing audio while the engine reports playing.
Read these alongside `player.unexpected_pause`, `player.unexpected_stop`,
`player.rebuffer`, `player.rebuffer_timeout`, `player.rebuffer_recovered` and
`player.playback_error`. Correlate the user, tab session, recording and observation
time with source-service logs; a loaded stream alone is not successful playback.

The browser retains at most 32 sanitized incidents for one hour in tab-scoped
`sessionStorage`, falling back to memory if storage is unavailable. Delivery is
serial, uses a five-second request timeout and exponential retry delay up to one
minute, and retries when connectivity/visibility returns. Closing the tab can
discard the outbox. Logout revokes the active outbox; owner checks on both sides
prevent queued events from being attributed to another account. Ordinary metrics
retain best-effort delivery.

The API process records at most 60 incidents per authenticated user per minute,
tracks at most 1024 users and deduplicates up to 128 recent event IDs per user for
one hour. Excess records are dropped; a 202 response is not a durable audit receipt.
Deduplication is process-local and resets on restart. Storage retention follows
the deployment's restricted container-log rotation policy, not the music database.

Inspect `Playback.Diagnostic` entries in the backend container logs for the affected
time window. Keep exports private: recording and user identifiers are operational
data. Do not enable global trace logs just to collect these incidents.

## Isolated playback tests

For automated playback testing on an existing listener account, send
`X-Soundspan-Diagnostic: playback` with **both** `POST /api/plays` and
`PATCH /api/plays/:playId/engagement`. Restrict header injection to the Soundspan
origin in an isolated test browser context. Close the context when finished.

Authentication and body validation remain required. Creation returns
`{ "id": "diagnostic-playback", "diagnostic": true }`; engagement returns
`{ "success": true, "diagnostic": true }`. No Play or playback attribution is
stored and no scrobble is forwarded. No schema migration or history deletion is
involved. Requests without the exact header retain ordinary behavior.

Send the same header with `GET /api/personalized/home` and
`POST /api/personalized/impressions` for Home/Wave tests. The feed computes its
ordinary personalized ranking but returns `generationId=diagnostic-recommendation`
without storing served or shadow generations, recommendation metrics or hot-set
analysis jobs. Impressions validate auth/body and return `{ recorded: 0, diagnostic: true }`.
Canonical identity and shared provider/feature caches can still be populated.

This isolates listening, skip and Home/Wave recommendation evidence, not the
whole account: likes, playlist edits, settings, playback-state sync and other
recommendation endpoints remain separate writes. Use a dedicated `isTestAccount`
fixture for whole-platform tests. Do not infer testing from short
listening duration or erase a real listener's historical skips.

An acknowledged diagnostic request is not evidence of successful audio output.
Verify actual media progress, recovery and natural queue transitions separately.
