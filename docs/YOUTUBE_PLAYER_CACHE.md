# YouTube player evaluation and transfer caches

The YouTube sidecar delegates JavaScript challenge evaluation to yt-dlp's
upstream providers. Soundspan does not register a custom EJS solver or share
serialized preprocessing between separate extractions. Successful solver JSON
alone is insufficient evidence that YouTube's CDN accepts the resulting URL.

## Cache ownership and compatibility

`ytmusic_player_cache.register_player_cache()` is a compatibility hook for the
optional stream bootstrap. It returns `False` without changing the upstream
provider registry. Repeated and concurrent calls have no registry side effects.
The bootstrap's version gate and exception handling cannot make this adapter
mandatory for ordinary extraction.

Public player source caching, anonymous visitor context, short-lived stream
URLs and the validated media spool have separate ownership and bounds. Their
contracts are independent of serialized EJS preprocessing. There is no custom
preprocessing disk state to migrate or clear.

JavaScript-dependent paths perform upstream challenge processing on demand.
Pacing, extraction budgets, cancellation and the single PO-recovery gate bound
this work. Audio format selection and the anonymous HIGH shortcut are separate
from the solver hook.

The behavioral tests are `test_upstream_player_solver.py` and
`test_player_cache_bootstrap.py` under `services/ytmusic-streamer/tests`.
Live acceptance must include sequential recordings in one process, complete
audio decoding and delayed Range requests. A first successful recording or a
mocked solver response cannot establish cross-request correctness.

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

Directory sweeps and byte reservations use a worker-only maintenance lock.
Reader pin counts use a separate short lock so publishing audio and closing
responses do not wait for a full directory scan or LRU sort. Eviction rechecks
pins under that short lock immediately before unlinking each file. Accounting
reuses metadata within one directory sweep, never a stale global size cache.
One authoritative sweep runs when a writer reserves space; its byte ceiling
covers the entire write, so no extra whole-cache prune runs before or after it.
Ready-file lookup filters directory-entry names before allocating file paths.

An egress proxy changes network routing, not provider access rights or capacity
guarantees. Use an owned, source- and destination-restricted proxy, preserve TLS
verification and retain a rollback route. Do not expose an open proxy. Compare
fresh audio IDs on equivalent scenarios and report burst latency separately
from sustained listener counts; HTTP first-byte time is not audible latency.
