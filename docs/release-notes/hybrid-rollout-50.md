# Hybrid rollout: 50% sessions

## Production transition

Applied on 2026-09-07 at 13:48:54 UTC (16:48:54 Moscow).

| Setting | Before | After |
| --- | --- | --- |
| Hybrid session assignment | 25% | 50% |
| Remote analysis daily admission budget | 250 | 500 |
| Remote analysis concurrency | 2 | 2 |

Both API and worker use the new configuration. Runtime images remain
`local/soundspan-backend:analysis-wave-0431e5c2` and
`local/soundspan-backend-worker:analysis-wave-0431e5c2`.
Frontend was not recreated. No schema, model, playback or ranking code changed.

Session assignment is deterministic, not a guaranteed exact 50/50 split in a
small sample. Increasing the threshold can move an existing session into Hybrid
on its next generation. Compare observations after the release boundary.

## Verification

- verify: backend build passed.
- verify: engine/ranker suites passed, 43 tests, including two added regressions:
  missing embeddings remain playable in both arms at 50%; failed feature/taste
  enrichment retains playable tracks while honoring known dislikes.
- verify: API and worker report 50/500/2 and are healthy; frontend-to-API probe
  passed; public `/api/health` returned 200.
- verify: host had approximately 22 GiB available RAM before rollout; post-rollout
  YouTube process used approximately 458 MiB of its 2 GiB limit.
- verify: analysis requests retain `purpose=analysis`; extraction budget reserves
  playback capacity and prioritizes listener work. No concurrency increase.

## Observed limits

At the first post-release snapshot, completed scalar analysis remained 1545 and
active-space embeddings 1548. No additional completions are claimed. Remote
analysis queue had zero waiting and zero active jobs at the follow-up check.
Today's Redis admission counter was 402 (includes denied attempts, not 402
completed analyses). Previously denied canonical reservations remain denied for
the UTC day. The increase allows fresh reservations but does not retroactively
retry those entries; no quota keys were deleted. Daily reset is at 00:00 UTC.

MusicBrainz 503 retries and Last.fm missing-artist errors remain visible in
metadata enrichment. Healthy containers do not establish recommendation quality
or universal provider availability.

## Decision gate for 100%

Keep the baseline comparison. Evaluate served-only, post-release real listening,
separately by surface and within accounts exposed to both algorithms. A practical
minimum is 100 measured outcomes per arm and five crossover accounts; this is an
operational floor, not proof of statistical significance. Missing observations
are not negative feedback or success.

Do not expand with increased empty/error responses, generation p95 more than
20% worse, early-skip rate more than 5 percentage points worse, or completion
rate more than 5 points worse. Review sample size, track mix and uncertainty.
Playback degradation or systemic failures require rollback without waiting for
the sample threshold. No automatic 100% rollout or scheduled monitor was created.

## Rollback

Scoped overlay backup in CT121:
`/srv/music/soundspan-releases/b0-b340a7c/compose-before-hybrid-50.json`.
Live overlay: same directory, `compose.json`.

Restore that backup to `compose.json`, then recreate only `backend` and
`backend-worker` using the existing production compose stack:

```sh
base=/opt/music-stack/soundspan-split
release=/srv/music/soundspan-releases/b0-b340a7c
cp "$release/compose-before-hybrid-50.json" "$release/compose.json"
docker compose -p soundspan-split-production --project-directory "$base" \
  --env-file /root/.config/music-stack/soundspan-split-production.env \
  -f "$base/docker-compose.yml" -f "$base/docker-compose.images.yml" \
  -f "$base/docker-compose.single-host.yml" -f "$base/docker-compose.backend-hotfix.yml" \
  -f "$release/compose.json" --profile worker up -d --no-deps backend backend-worker
```

Verify both health checks and 25/250/2 afterward. Do not use the earlier
pre-0431e5c2 image backup for this configuration rollback.

## Final risk review

Scope: config-only 25→50 and 250→500; two safety regression tests.
Verdict: CLEAN for this bounded expansion, not acceptance of 100% Hybrid.
Backup/automatic health-failure rollback, unchanged images/concurrency, both-role
configuration and no Redis deletion were checked. Residual risks: real-listening
quality remains observational; today's sticky quota denials and external
metadata failures limit immediate additional analysis.
