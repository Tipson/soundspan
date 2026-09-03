# Playback OOM incident — 2026-09-03

## Cause and correction

The standalone YouTube Music container had a 512 MiB limit. Four metadata
extraction workers and two spool workers could independently start yt-dlp/Deno.
Kernel OOM kills of uvicorn severed active audio connections; the API then saw
socket hang-ups and connection refusals. This demonstrates insufficient resource
headroom, not a persistent memory leak.

- One thread-owned heavy-work budget covers metadata, playback and library/album
  downloads. Its default is two jobs. Cancelling an HTTP waiter does not release
  a still-running worker's slot. Waiting playback precedes metadata/background work.
- Metadata admission is bounded to eight jobs; expired or cancelled queued metadata
  does not start provider work after capacity returns.
- Quality badges wait for playback and read only metadata already collected by
  the audio download. Cache misses are unknown values, not new yt-dlp jobs.
- Stream metadata cache keys include quality. The cached payload omits the large
  provider format table. Public and OAuth-gated music URLs both use anonymous
  extraction; credential-gated operations retain their authorization checks.
- A missing-format extraction failure gets at most one paced retry inside the
  same worker slot. Unavailable content and verification challenges retain their
  existing error handling.
- Standalone Compose and Helm streamer defaults allocate 2 GiB. Production uses
  two CPUs, a two-job extraction budget and a 3 GiB combined memory/swap limit.

## Verification

- verify: the original six-request isolated replay at 512 MiB exhausted RAM and
  swap and disconnected all six requests; at 1536 MiB it peaked near 1529 MiB.
- verify: Linux Python 3.14 sidecar suite: **391 passed**. Regression tests cover
  combined concurrency, worker-lifetime limits, expired queued metadata, playback
  priority, passive metadata, library-download gate coverage and bounded retries.
- verify: targeted backend suites: **94 passed**; backend build and frontend
  production build/typecheck passed. Frontend component/API tests check deferred,
  cache-only quality queries.
- verify: isolated replay after twelve deliberate client timeouts while switching
  among four tracks: the two final audio requests succeeded, four passive metadata
  reads succeeded, and two cached Range requests returned HTTP 206 in about 10 ms.
  No OOM kill or service restart occurred. Later YouTube responses did not spawn
  Deno, so their smaller memory peak is not a like-for-like Deno benchmark.
- verify: production API returned 64 KiB of audio with HTTP 206 in 6081 ms;
  the same request through the frontend returned HTTP 206 in 32 ms. Passive
  metadata returned the downloaded Opus bitrate without a second extraction.
- verify: only ytmusic-streamer, backend API and frontend were recreated. The
  resolved Compose diff was checked to preserve all other service definitions,
  mounts, networks and credentials. Database, worker and analyzers were not restarted.
- verify: post-deploy health checks passed; restart counters were zero and the
  inspected post-deploy logs contained no incident socket/OOM/extraction errors.

Production image tags: `local/soundspan-ytmusic-streamer:oom-20260903`,
`local/soundspan-backend:oom-20260903`, `local/soundspan-frontend:oom-20260903`.
Deployment completed around 16:10 Moscow time.

## Adversarial review

Verdict: **CLEAN for this incident correction**. The independent failure-focused
pass covered HTTP timeout versus actual thread lifetime, queue saturation,
priority, duplicate metadata work, quality-key separation, authorization,
bounded retry and mixed-version deployment. It found two additional library
download paths outside the shared budget; both were covered and tested before
deployment. No in-scope P0/P1 finding remained.

## Remaining boundaries

Cold YouTube delivery can still take seconds; this release is not a guarantee of
instantaneous startup or immunity to provider/network/content restrictions.
The smoke tests validate transport bytes, not audible playback on an iPhone.
Warm disk entries surviving a restart may have no in-memory bitrate metadata;
playback remains available and the badge may display unknown quality.

Pre-existing repository-wide size-gate violations in `routes/playlists.ts` and
`services/spotify.ts` remain outside this incident. No GitHub push or PR was made.
