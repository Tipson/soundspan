# YouTube player preprocessing cache

The YouTube sidecar shares serialized EJS preprocessing of public player code
between fresh yt-dlp instances. Audio URLs, cookies, account identifiers,
challenge inputs and challenge responses are not cache entries. Every request
is evaluated independently; audio format selection is unchanged.

## Bounds and failure behavior

- At most two entries and 16 MiB of retained serialized bytes per process.
- Entries expire after one hour; LRU eviction keeps the byte budget bounded.
- The key includes the public script content and EJS version. A changed script
  cannot reuse preprocessing from another script.
- JSON decoding and Deno execution still require temporary working memory;
  the 16 MiB limit is not a limit on the complete process RSS.
- A failed cached execution is retried once using the original public script.
  The stock yt-dlp Deno provider remains available as a fallback.
- Cache state is in memory only; service restart discards it. There is no disk
  cache to clean and no schema or user-data migration.

## Compatibility

Registration is lazy and limited to yt-dlp `2026.08.19`, whose private EJS hooks
are covered by the adapter tests. The version check happens before importing
those hooks. Other versions continue with stock extraction and an informational
log message. Initialization errors are logged by exception type, without
request data, and do not prevent extraction. A dependency update requires
explicit adapter revalidation before expanding the supported version.

This optimization avoids repeated preprocessing. It does not remove the first
player download, the first preprocessing run, metadata requests, admission
queues or audio-CDN latency. Its component benchmark is not an end-to-end
playback latency guarantee or a concurrent-listener capacity result.

The behavioral tests are `test_player_preprocess_cache.py` and
`test_player_cache_bootstrap.py` under `services/ytmusic-streamer/tests`.

## Independent connection stalls

The progressive audio path caps connection establishment, including proxy
CONNECT, at three seconds (or the smaller remaining transfer budget). It retries
one timed-out request opening before receiving response headers. A continuation
retry keeps the same Range and If-Range values. Response-body timeouts are not
retried from zero; published bytes are never duplicated. Body-read timeout,
representation validation, cancellation and the overall transfer deadline are
preserved. This is distinct from EJS processing and does not diagnose all
connection failures as provider rate limits.

`test_cdn_connection_retry.py` includes a real loopback proxy that stalls CONNECT,
plus retry, cancellation, deadline and byte-continuity cases.

## Transfer-scoped connections

Each progressive download owns a Requests session, reusing its connection for
fully consumed contiguous ranges instead of reopening proxy CONNECT/TLS for
every range. The pool closes when iteration completes, fails or is cancelled.
Sessions and their cookies are not shared across separate transfers. The
CDN admission limits bound active range requests; whole-file writer admission
separately reserves worst-case disk space. No global connection pool is used.

`test_cdn_connection_reuse.py` verifies connection reuse against a real local
HTTP server, cookie isolation between transfers and pool cleanup on all exits.
This improves buffer filling, not the first metadata extraction or first
connection handshake.

## Concurrent cold starts

Playback constructors register only the YouTube extractor. The pinned anonymous
HIGH shortcut accepts one original, non-live Opus 251 rendition without cipher
or `n` URL transformations, under the configured quality ceiling. Ambiguous
language tracks, duplicate renditions, changed schemas or missing formats use
ordinary extraction. The music-only response adapter skips unused caption URL
expansion; it does not alter audio. These private hooks share the exact upstream
version gate in `ytmusic_anonymous_context.py`.

At extraction concurrency four or higher, anonymous player work runs in at most
eight spawned processes (half the configured extraction concurrency). Startup
initializes modules and plugins without fetching tracks. Parent-owned pacing,
heavy-work slots, caches and the single challenge-recovery gate remain shared.
HTTP cancellation does not release a slot while a process still owns work.
Shutdown rejects new jobs and cancels unstarted probes; running network work
retains its socket timeout. Worker memory counts against the container limit.

Spool admission allows eight queued jobs per configured resolver, at most 128.
It does not increase active extraction, CDN or writer limits. Writers queue
within the disk reservation budget. The initial CDN request covers up to 64 KiB;
subsequent ranges cover up to 1 MiB. Each range reacquires network admission and
buffered tails yield priority to new playback prefixes. Representation and
contiguous-byte checks, cancellation, atomic completion and reader pins apply
throughout; no transcoding or lower-quality substitution is introduced.

An egress proxy changes network routing, not provider access rights or capacity
guarantees. Use an owned, source- and destination-restricted proxy, preserve TLS
verification and retain a rollback route. Do not expose an open proxy. Compare
fresh audio IDs on equivalent scenarios and report burst latency separately
from sustained listener counts; HTTP first-byte time is not audible latency.
