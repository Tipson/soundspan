# [1.9.0] Release Notes - 2026-08-08

Soundspan 1.9.0 turns the Vibe map into a full interactive music navigator, adds
faster and more accurate discovery paths, and completes a broad runtime and
dependency modernization pass. It is also the first release in a while with
required operator coordination: the database gains an indexed shuffle-sampling
column, and the YouTube Music and TIDAL sidecars now fail closed unless they
share the backend's internal secret.

## Before you upgrade — required checklist

- **Upgrade the chart and all Soundspan images together to `1.9.0`.** Do not
  mix a 1.9.0 backend with older TIDAL or YouTube Music sidecars: the backend
  now authenticates every sidecar request and the older deployment contract
  does not.
- **Confirm `INTERNAL_API_SECRET` is the same on the backend,
  `ytmusic-streamer`, and `tidal-downloader`.** The bundled Helm chart and
  `docker-compose.yml` wire this automatically. Custom deployments, including
  HTTP sidecars run beside the AIO image, must set the value explicitly before
  starting 1.9.0. A missing or mismatched value makes sidecar calls fail closed
  with HTTP 403; `/health` remains available for probes.
- **Back up PostgreSQL and allow migration
  `20260711012100_add_track_random_sample_column` to finish.** The standard
  backend and AIO entrypoints run `prisma migrate deploy`; custom migration
  workflows must apply it before serving 1.9.0 traffic. The migration stages
  its backfill and builds `Track_random_idx` concurrently to avoid the original
  table-rewrite and write-blocking index rollout.
- **Use Node.js 24 for source installs and custom builds.** Published images
  already include Node 24; Node 20–23 host installs are no longer supported.

## The Vibe map becomes an interactive navigator

The Map tab is now full-bleed and built for active exploration rather than
being a static scatter plot. It adds a playing-track beacon, camera controls,
session trails, per-mood filters, energy and mood ranges, a spread layout,
calibrated match percentages, semantic spotlight search, queue flight plans,
and a sweep gesture that can play, queue, or save the dots it crosses.

Four focused modes turn the map into different listening tools:

- **Travel** walks the similarity graph one neighbour at a time and explains
  why each candidate matches.
- **Journey** plots a playable route toward a track or mood.
- **Drift** builds a twelve-step mood slide.
- **Alchemy** blends two to ten weighted tracks into a shared direction.

Late Journey, Alchemy, Spotlight, and sweep-save responses can no longer
overwrite newer choices, and partial playlist saves report the tracks that did
not land instead of displaying a false success.

## Player and discovery improvements

- Player transports gain 15-second skip-back and skip-forward controls for
  podcasts and audiobooks.
- The player shell no longer re-renders four times per second during playback,
  reducing avoidable mobile work while preserving full-precision progress
  persistence.
- Similar-track and Vibe searches use tuned pgvector probes, materially
  improving nearest-neighbour recall on indexed libraries.
- Large-library shuffle uses the new indexed random column instead of sorting
  the entire Track table with `ORDER BY RANDOM()`.
- Spotify and Deezer import matching runs through a bounded-concurrency queue,
  and Discover Weekly batches library-membership checks.

## Security and reliability

- `/api/releases` now enforces authentication as its API documentation already
  promised.
- Offline-cache and Continue Listening endpoints now consistently scope reads
  and deletes to `req.user.id`, closing cross-user exposure/deletion paths on
  multi-user deployments and repairing five endpoints that previously failed.
- Direct Soulseek acquisition now requires an administrator, matching the
  existing YouTube acquisition boundary.
- Every build-time ML model download is pinned to a digest and verified before
  it can enter an image; the CLAP checkpoint also uses an immutable upstream
  revision.
- Python runtime images install from interpreter-specific, hash-pinned locks.
  CI now blocks unexpected `pip-audit` advisories, while the documented legacy
  TensorFlow compatibility exceptions remain explicit rather than silently
  passing.
- AIO startup, Redis blocking polls, reused frontend proxy connections, and
  duplicate Lidarr grab webhooks all received focused failure-path fixes.

## Platform modernization

- Prisma 7 now uses the PostgreSQL driver adapter and preserves custom
  `schema=` values from `DATABASE_URL`. Pool sizing is controlled by
  `DATABASE_POOL_SIZE` and `DATABASE_POOL_TIMEOUT`.
- Express 5, node-redis 6, connect-redis 10, Zod 4, TypeScript 6, ESLint 10,
  and the current frontend proxy stack replace their previous major versions,
  with compatibility migrations included.
- Backend, frontend, worker, and AIO images now share the Node 24 Bookworm
  runtime contract.
- Frontend component tests and standalone backend/frontend typechecks are part
  of CI visibility, and security scanning now covers CodeQL, dependency
  review, Trivy, gitleaks, and Python audits.

## Deployment and distribution

- Docker images: `ghcr.io/soundspan/*:1.9.0`
- Helm chart repository: `https://soundspan.github.io/soundspan`
- Helm chart reference: `soundspan/soundspan`

```bash
helm repo add soundspan https://soundspan.github.io/soundspan
helm repo update
helm upgrade --install soundspan soundspan/soundspan --version 1.9.0
```

The chart is published only after all eight `1.9.0` image tags are available.

## Known issues and compatibility notes

- The legacy MusicCNN analyzer remains on Ubuntu 20.04, Python 3.8, and its
  TensorFlow/Essentia-compatible dependency line. The AIO TensorFlow stack has
  related constraints. Their current `pip-audit` exceptions and removal
  conditions are documented in `docs/SECURITY.md`; new advisory IDs still fail
  CI.
- Standard Docker and Helm upgrades preserve existing data and apply the new
  Prisma migration automatically. Custom deployments remain responsible for
  database backups, migration ordering, and consistent sidecar secrets.

## Full changelog

- Compare changes: [1.8.0...1.9.0](https://github.com/soundspan/soundspan/compare/1.8.0...1.9.0)
- Full changelog: [CHANGELOG.md](https://github.com/soundspan/soundspan/blob/1.9.0/CHANGELOG.md)
