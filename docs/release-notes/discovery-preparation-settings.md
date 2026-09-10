# Discovery preparation and device settings

The remote-analysis worker starts a Discovery preparation pass at startup and
every fifteen minutes when audio analysis and remote analysis are enabled.
One pass visits at most four real accounts with recent playback and twelve
Discovery candidates per account. It computes the same diagnostic Wave feed
without recording recommendation generations, exposures or plays. Per-account
cursors and a rotating account cursor expire after seven days in Redis below
`recommendation:discovery-prefetch`.

A shared three-minute Redis lease prevents concurrent passes. Admission stops
after 150 seconds, on shutdown, when twelve jobs are pending, or when estimated
used/pending work plus the next batch would exceed half the configured daily
budget. This is a conservative admission threshold; the existing worker's
atomic global budget remains authoritative. Foreground jobs use Bull priority
1 and preparation jobs priority 10, with the same canonical job identities,
coverage checks, cooldowns and worker concurrency. Shutdown fences late
results and waits up to twenty seconds before closing the queue.

Observe `DiscoveryAnalysisPrefetch` completion/failure logs (completion requires
INFO logging), the persisted cursor keys, normal analysis job state and the
global daily budget. A cancelled pass cannot enqueue after its lease check
returns. Successful admission is not proof that audio analysis has completed;
verify the resulting canonical analysis/embedding rows separately.

The account discovery query is bounded to the first hundred recently active
accounts in ID order. Deployments exceeding that population need keyset
pagination. A failing account keeps its candidate cursor; repeated failures
across the first batch can delay later accounts and should be investigated
through the failure logs.

YouTube Radio warnings report seed ID, reason and optional HTTP status, without
Axios headers or upstream bodies. Reasons distinguish empty, invalid, timeout,
rate limiting, unavailable seed and other upstream/transport failures. Empty
or invalid responses are rejected before the thirty-second singleflight cache;
the next request can refill normally. No extra synchronous retry is added.

User settings have four sections with preserved drafts. Scrobbling and
Integrations are absent from this screen; service configuration is not deleted.
The global save action appears only for changed account settings and occupies
normal document flow. Device downloads save their own state immediately.

Device policy version 2 enables liked-song downloads without application
count/byte caps or automatic eviction. Users can pause them explicitly. Browser
storage permission, physical free space, connectivity and foreground execution
still apply. A storage failure pauses the persisted queue until explicit retry.
Existing files, manual ownership and other accounts remain intact.

Rollback uses the saved Compose overlay and previous backend, worker and
frontend images. No database schema or existing audio files are migrated by
this release. Retained device queue fields are additive. An old frontend can
apply its former automatic caps if it runs after rollback; do not keep old
client tabs active while validating the unlimited-download policy. Database
backup restoration is not needed for an image-only rollback.
