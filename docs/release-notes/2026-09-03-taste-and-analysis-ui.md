# Taste setup and analysis visibility — 2026-09-03

## Production findings before the UI release

- verify: `soundspan-prod-ytmusic` runs `local/soundspan-ytmusic-streamer:oom-20260903`
  with a two-job extraction budget, 2 GiB memory limit, zero restarts and cgroup
  `memory.events` counters `max=0`, `oom=0`, `oom_kill=0`. Snapshot usage was
  383.4 MiB. The correction covers aggregate heavy-work admission and passive
  bitrate metadata, not only a larger memory limit; see the playback OOM report.
- Provider format messages and frontend socket hang-ups remain in the wider
  post-deploy log window. These are not evidence of another OOM and are not a
  guarantee of flawless playback. No provider/retry changes are part of this UI release.
- verify: PostgreSQL aggregate snapshot: 2,367 canonical recordings, 568 completed
  scalar analyses (24.0%), 580 completed embeddings (24.5%), zero local audio files.
  Over the previous 24 hours, 280 scalar analyses and 250 embeddings completed.
  Both latest completions were on September 3 around 18:42 Moscow time.
- verify: online analysis is enabled, daily admission budget 250, concurrency 2.
  Scalar statuses: 568 completed, 2 failed, 1,797 pending. Embedding statuses:
  580 completed, 6 failed, 1,781 pending. Pending is not a promise that every row
  is immediately queued: hot-set selection, source availability and budgets apply.
- The settings counters originate from `unifiedEnrichment.loadEnrichmentProgress`:
  local `Track` files and `track_embeddings`, not `CanonicalRecording` and
  `canonical_recording_embeddings`. Therefore their old `0/0` did not measure
  online coverage. No analysis data was reset or regenerated for this request.

## UI changes

- Explicitly label local audio and CLAP counts; empty stages have a neutral
  message instead of a green completion mark and zero-percent bar. Local reset
  buttons are disabled without local files. A note separates the online pipeline.
  A live online-coverage dashboard is not introduced in this frontend-only change.
- Taste setup: genres → artists → review. 34 genres in six groups, genre search,
  genre-filtered and mixed artist shelves, on-demand expansion, persistent selected
  artists, and removal of saved labels absent from suggestions.
- Artist shelves are curated examples, not a complete Yandex catalog. MusicBrainz
  autocomplete and the existing account-scoped API remain unchanged. No extra
  provider fan-out, likes, database migrations or changed selection limits.
- Long lists scroll separately; step actions remain visible. A compact mobile
  header keeps space for content. The reference and explicit differences from
  Yandex's documented flow are recorded in the taste-profile README.

## Verification

- verify: 27 targeted frontend component/unit tests passed; production Next build
  and standalone TypeScript check passed. ESLint has zero errors and one existing
  effect-state warning in the autocomplete focus-index code.
- verify: isolated browser component flow selected genres, selected an artist,
  reviewed and saved the exact payload without writing a real account. Desktop,
  390×844 and 320×568 layouts were inspected; no horizontal overflow, footer inside
  viewport. This is component QA with app CSS, not a real iPhone playback test.
- verify: repository size gate retains two pre-existing failures in backend
  playlists and Spotify files; no changed file violates its size limit. No PR or
  full backend coverage run is included in this frontend-only release.

## Adversarial review

Verdict: CLEAN within the changed UI and unchanged API contract. Checked saved
unknown genres, cross-filter selections, stale autocomplete results, account-keyed
state, maximum counts, duplicate save clicks, neutral empty analysis and mixed
frontend/backend versions. No in-scope P0/P1 remained. Infinite artist maps,
preview playback, live online-coverage UI and provider incident follow-up remain
outside this release.

## Publication

verify: Linux production build passed. Only the frontend image changed in the
fully resolved Compose configuration; backend, worker, streamers, database and
analyzers were not recreated.

Published image: `local/soundspan-frontend:taste-20260903`, revision `8fa5a65`,
image ID `sha256:44bf6be14feccfb00c73ca2c00f3d14828210d63c256b55460e3f4a25b55098b`.

verify: public `https://music.agentik007.ru/health` returned 200. The public
versioned JavaScript assets returned 200 and contained all three checked release
markers (expanded genre, neutral empty-local-analysis message, review-step action).
No GitHub push was performed. The browser QA server was stopped after use.
