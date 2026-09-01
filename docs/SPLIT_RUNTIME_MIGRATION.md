# Split-runtime migration

This runbook moves a single-host Soundspan deployment from the all-in-one
container to independently versioned frontend, API, worker, PostgreSQL, Redis,
audio-analysis, DCLAP, and streaming containers.

The split stack is the production target for maintained forks. The AIO image is
still useful for evaluation, but rebuilding it for an unrelated UI or API change
also rebuilds PostgreSQL, Redis, TensorFlow/Essentia, DCLAP, and both Node apps.

## Release source

Use a repository owned by the deployment operator. The image workflow publishes
one GHCR repository per component:

```text
ghcr.io/<owner>/<repository>-frontend
ghcr.io/<owner>/<repository>-backend
ghcr.io/<owner>/<repository>-backend-worker
ghcr.io/<owner>/<repository>-audio-analyzer
ghcr.io/<owner>/<repository>-vibe-provider-dclap
ghcr.io/<owner>/<repository>-tidal-streamer
ghcr.io/<owner>/<repository>-ytmusic-streamer
```

A main push builds only components affected by the changed paths. A release or a
manual `all` run builds all seven images. Production must use the immutable
`main-<short-sha>` or release-version tag, not `main` or `latest`.

## Data that must survive

- the PostgreSQL `soundspan` database;
- `SESSION_SECRET`, `SETTINGS_ENCRYPTION_KEY`, `INTERNAL_API_SECRET`, and the
  PostgreSQL password (never print or commit them);
- the existing music bind mount;
- optionally `/data/cache/covers` and `/data/cache/transcodes` (both can be
  regenerated);
- the AIO volume, kept intact until the split deployment is accepted.

Redis is coordination/cache state, not the source of truth. Stop new background
work, let active jobs finish, and start the split Redis empty. Do not copy raw AOF
files between the embedded AIO Redis and the standalone image.

## Staged migration

1. Record the running AIO image digest and Compose configuration. Confirm the
   AIO health endpoint is green.
2. Pause imports, downloads, scans, and analysis scheduling. Wait for active
   work to finish.
3. Create a PostgreSQL custom-format dump from the running AIO container and
   store it outside the AIO volume:

   ```bash
   docker exec soundspan gosu postgres pg_dump -Fc -d soundspan \
     > soundspan-before-split.dump
   test -s soundspan-before-split.dump
   ```

4. Prepare a private `.env` for the split stack. Preserve the existing stable
   encryption/session secrets and PostgreSQL password. Set the same host music
   path and the immutable image coordinates:

   ```dotenv
   SOUNDSPAN_IMAGE_REPOSITORY=ghcr.io/<owner>/<repository>
   SOUNDSPAN_IMAGE_TAG=main-<short-sha>
   MUSIC_PATH=/srv/music/library
   ```

5. Pull the split images before downtime:

   ```bash
   docker compose -f docker-compose.yml -f docker-compose.images.yml \
     --profile worker pull
   ```

6. Stop (do not remove) the AIO container. Start only split PostgreSQL and Redis,
   restore the dump, and run the repository migrations through the backend
   entrypoint. Use a separate Compose project during rehearsal so its volumes
   cannot collide with production.
7. Start API and worker; require healthy PostgreSQL and Redis in
   `/api/health/ready`. Then start DCLAP, the analyzer and provider sidecars.
   Start frontend last.
8. Verify login, account isolation, search, one real provider stream with a Range
   request, My Wave, similar tracks, one background analysis job, and one device
   download. Compare key row counts before changing the reverse proxy.
9. Switch the reverse proxy only after the checks pass. Keep the stopped AIO
   container and its volume unchanged through the acceptance window.

## Start command after cutover

```bash
docker compose -f docker-compose.yml -f docker-compose.images.yml \
  --profile worker up -d --no-build
```

`docker-compose.images.yml` requires an explicit tag and defaults to pulling it.
This prevents an accidental local rebuild or deployment of an unpinned image.

## Acceptance gates

- every split container is healthy;
- API readiness reports both PostgreSQL and Redis healthy;
- API logs report `BACKEND_PROCESS_ROLE=api`; worker logs report
  `BACKEND_PROCESS_ROLE=worker`, with no duplicate schedulers/processors;
- no Prisma connection targets `127.0.0.1` in component containers;
- API and worker use distinct role-aware pool limits;
- the frontend proxies `/api` to the split backend;
- DCLAP and audio analyzer health checks pass before analysis is enabled;
- the deployed image digests match the selected immutable tag;
- the old AIO volume is not deleted as part of the cutover.

## Rollback

Stop the split project, restore the previous reverse-proxy target, and restart
the untouched AIO container. If the split deployment accepted writes after the
cutover, do not blindly return to the older AIO database: export and reconcile
the new PostgreSQL state first.
