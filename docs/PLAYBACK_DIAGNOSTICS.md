# Playback diagnostics

## Playback incidents

The authenticated `POST /api/streaming/v1/client-metrics` endpoint accepts player
signals. Queued incidents are appended to a persistent JSONL journal and mirrored
through the `Playback.Diagnostic` logger at `warn` level, independently of
`STREAMING_TRACE_LOGS`. The existing metrics remain available. Incident lines contain
a JSON object with `event`, authenticated
`userId`, server `receivedAtMs`, and bounded `fields`. Queued events also include
`eventId` and client `observedAtMs`; client clocks are not authoritative.

The version-2 fields include a random `playbackRunId` for one loaded source,
`sourceKind` (`device_file`, `network`, or `unknown`), playback position, contiguous
buffered seconds, play intent, UI/engine state, browser visibility, coarse browser/OS
family, reported network availability, error category/code and recovery stage.
Native snapshots add paused/ended status, ready/network state, media error code,
AudioContext state, coarse effective connection type and data-saving preference.
`diagnosticsVersion=2` identifies this diagnostic contract, not a server build.
`frontendBuildId` identifies the executing client bundle and matches its Next
`BUILD_ID`. It is embedded during compilation and retained with the observation,
including when a later client uploads an older offline backlog. Missing values
mean an unidentified client; the receiving server's build is not a substitute.
The identifier is diagnostic context, not a trusted attestation of client code.
`visibility=hidden` means the document is in the background; it does not prove the
phone is locked. `online=true` does not prove that an upstream provider is reachable.
Raw error messages, source URLs, headers, credentials, full user-agent strings,
track IDs, playback session IDs and arbitrary client fields are excluded from
incident logs and the browser outbox. Account identity comes from server
authentication; the envelope owner is only an account-switch guard.

`player.recovery_attempt` records a scheduled same-track retry,
`player.recovery_ready` records a correlated loaded stream, and
`player.recovery_resumed` requires advancing audio while the engine reports playing.
Read these alongside `player.unexpected_pause`, `player.unexpected_stop`,
`player.rebuffer`, `player.rebuffer_timeout`, `player.rebuffer_recovered` and
`player.playback_error`. `player.engine_pause`, `player.track_end` and
`player.visibility_change` capture surrounding lifecycle context. Correlate the
authenticated user, random playback run and observation time with source-service
logs; a loaded stream alone is not successful playback. Native position updates
are observed in memory rather than written to storage on every `timeupdate`.

The browser retains at most 96 sanitized incidents / 64 KiB for 24 hours in
`localStorage`, with one account-scoped storage key per event so concurrent tabs
do not overwrite each other's newly queued incidents. Storage failure falls back
to memory, which cannot survive process termination. Normal persisted events
survive reloads and browser closure, subject to browser storage eviction. Delivery
is serial, uses a five-second request timeout and exponential retry delay from
two seconds to one minute, with at most six automatic attempts before waiting for
an online/visible lifecycle wake. Logout revokes the active outbox; owner checks
on both sides prevent queued events from being attributed to another account.
Ordinary metrics retain best-effort delivery.

The API process records at most 60 incidents per authenticated user per minute,
tracks at most 1024 users and deduplicates up to 128 recent event IDs per user for
24 hours. Concurrent deliveries of the same event join the pending write; an ID is
marked received only after the append succeeds. Deduplication is process-local and
bounded: an evicted ID or a retry after API restart can produce duplicate JSONL
lines with the same authenticated user and event ID. This is not exactly-once
delivery and does not use listening-history tables.

Each HTTP request carries one event, optional bounded `fields`, and
`diagnostic: { id, ownerId, observedAtMs }`. Diagnostic requests are limited to
8192 UTF-8 bytes and an allowlisted event name. Client observation times older
than 24 hours or more than 60 seconds ahead of server time are rejected. Browser
clock skew can therefore discard an incident; the server receipt time remains
authoritative.

| Response      | Queued diagnostic delivery                                                                                               |
| ------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `202`         | The JSONL append and file `fsync` completed, or this process already received the same event. Remove it from the outbox. |
| `400` / `413` | Invalid, expired, wrong-owner or oversized request. Do not retry it.                                                     |
| `429`         | Per-user rate limit. Keep it and retry after `Retry-After` / bounded backoff.                                            |
| `503`         | Persistent storage failed or the 128-write queue is full. Keep it and retry.                                             |

The journal lives at `logs/playback-diagnostics` under the API working directory,
which is `/app/logs/playback-diagnostics` in the container. Production must retain
the writable `/app/logs` volume when replacing the API container. The journal
uses private directory/file modes (`0700` / `0600`), up to eight 4 MiB files and
seven-day server ingestion retention. Cleanup runs on append at most every five
minutes and during rotation, including a UTC-day boundary; an idle journal is
pruned when ingestion resumes. Cleanup only removes regular files matching its
strict `incident-<server-time>-<random>.jsonl` filename pattern. Other artifacts
and symlink entries are preserved, and a symlink journal directory is rejected.

Writes, rotation and cleanup share one serialized queue. The journal is designed
for the deployment's single API writer; multiple replicas need independent
directories or a shared external collector. File `fsync` protects acknowledged
records across API replacement on the retained volume; it is not a backup or a
guarantee against volume loss. A failed write can leave an incomplete final JSONL
line; readers should ignore that incomplete tail. Subsequent retries write to a
new file and retain their event IDs.

Inspect the persistent journal for the affected observation/receipt window.
`Playback.Diagnostic` console entries provide a convenient mirror, but container
stdout alone does not survive container removal. Keep exports private: user
identifiers and playback timing are operational data. Do not enable global trace
logs just to collect these incidents.

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
