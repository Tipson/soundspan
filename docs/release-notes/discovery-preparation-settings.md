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

## Verified rollout: 2026-09-10

Code revision `a5de3eb4` was released as
`local/soundspan-{backend,backend-worker,frontend}:discovery-settings-a5de3eb4`.
The frontend build is `Q6jmU-vtGaoYzDMTcvEbV`. Runtime hashes of all six backend
modules match the local build in both processes. All three services became
healthy and the twelve neighboring containers retained their IDs.

The checked database dump is 22,264,208 bytes, SHA-256
`4f4fb96ad4ea424723d721a47c33f1b839faf2ce937692dca3eeb7390a91b982`.
The dump and prior overlay are retained under
`/srv/music/soundspan-releases/discovery-settings-a5de3eb4-detp7ybw/backup`.
No database restore or migration was performed.

verify: backend build and full Linux coverage passed: 8,531 tests, seven
skipped, 600 passed suites, zero failures, 94.56% line coverage. Frontend
typecheck, webpack build, 1,619 unit tests, 1,272 component tests and strict
targeted native coverage passed. ESLint reported zero errors and 101 warnings
within the repository limit. The default Turbopack build cannot traverse the
existing external node_modules junction; the supported webpack build was used.

verify: public health and API health returned 200; authenticated public Range
playback returned 206, audio/webm and 65,536 bytes in 155 ms. Four real-account
Wave requests returned 200 without history changes; the first calm request
used the optional dclap-mood fallback. The post-release Radio replay completed
twelve calls and four Discovery pages without Radio degradation. Concurrent
mapping attempts logged retried Prisma write conflicts; the replay completed.
The final repeated four-account smoke at 15:32 UTC returned 200 without any
degraded sources and again left generation, exposure and play counts unchanged.

verify: a separate Chromium test account exercised draft persistence, save and
reload, restoration of original settings, desktop/mobile layouts, menu focus,
default automatic download of a liked 3.3 MB track and playback from a blob URL
after network blocking. Its temporary like was removed through the UI and
confirmed after reload. The public deployment exposes the same four settings
sections and enabled download default. Physical-phone acceptance remains open.

verify: the startup preparation advanced two account cursors and admitted
priority-10 jobs alongside priority-1 foreground jobs. The budget stayed at
750/day and concurrency at two; no synthetic generations were recorded.
At 15:32:25 UTC, all eleven observed preparation candidates had completed both
analysis and embeddings, and their asset leases were completed. The transfer
queue was empty. Daily admissions stood at 113, including ordinary foreground
work; this is not a separate count of preparation jobs.

The separate 48-scenario quality replay found no disliked tracks, duplicate
IDs, tracks over fifteen minutes, repeats from the previous day's exposures or
liked tracks in Discoveries. Dartum's active calm/energetic mean arousal was
0.292/0.774. Two smaller accounts did not obtain meaningful mood separation;
full changing-catalog coverage and subjective listening acceptance remain open.
The local artifact `soundspan/output/soundspan-wave-listening-comparison.md`
contains the per-account results and a short baseline/active listening list.
