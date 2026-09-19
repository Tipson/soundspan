# Concurrent cold playback — 9 September 2026

Released commits: `5398e3eb`, `cefb5570`, `f0aed1dd`. No git push.
Production image: `local/soundspan-ytmusic:cold-sweep-f0aed1dd`.

## Delivered changes

- Separate bounded resolver, queued-job, disk-writer and CDN-range admission.
- Initialize a bounded anonymous-player process pool before readiness; use the pinned original-audio fast path only when its format is unambiguous.
- Prefer a new listener's first 64 KiB over buffered tails. Preserve original audio, quality ceilings, cancellation, Range/If-Range validation and one shared download per track.
- Separate reader pins from directory maintenance; atomically recheck pins before eviction.
- Account for disk capacity once at writer reservation, not three times per download. Avoid constructing paths for unrelated entries during cache lookup. Preserve the 8 GiB aggregate / 128 MiB track limits.
- Route the audio sidecar through four persistent SSH channels, privately balanced by HAProxy and Privoxy. The original single-channel route remains available for rollback.

## Verification and limits

| Scenario | Outcome | First-byte latency |
| --- | --- | --- |
| Baseline, 10 distinct cold tracks | 3 HTTP 503; 7 audio responses, two subsequently hit the diagnostic deadline | 7.7–19.0 s for audio responses |
| Intermediate single-channel production, 100 fresh tracks | 99 completed 30 s reads; one diagnostic deadline | p95 12.119 s |
| Same 100 IDs, isolated empty spool and four-channel route | 100/100 completed 30 s reads | p95 2.433 s |
| Four-channel production before sweep reduction, 100 fresh tracks | 99 audio; one age-restricted 451; no system failures | p95 8.478 s |
| Final production, 100 fresh tracks | 99 audio; one age-restricted 451; no system failures | p95 2.654 s |
| Final production, another 110 fresh tracks | 110/110 audio, peak 110 simultaneous readers, zero errors | median 1.820 s; p95 3.314 s; max 5.279 s |

Fresh production IDs exclude files in the actual spool and IDs from earlier production runs. The last two cohorts come from existing catalogue tracks lasting 120–360 seconds because fresh liked tracks were exhausted. Cohorts differ: their p95 comparison is not a controlled same-song A/B test. The matched 100-ID comparison above tests the egress change with an isolated empty spool.

The final HTTP check adds one client every 150 ms, reads each audio response for 30 s at approximately 32 KiB/s, and traverses the real internal frontend → backend → sidecar → YouTube/CDN path. The 110-client run received 126,615,368 bytes; every client received at least 983,040 bytes and consumed for approximately 30 s. Maximum wait inside a body read was 1.72 ms, but transport buffering means this alone is not an upstream jitter measurement. It is neither a 110-at-once click burst, nor 110 browser decoders, nor a public-TLS load/long soak acceptance.

- verify: 645 sidecar tests passed, 4 skipped; 952 existing FastAPI deprecation warnings. Ruff check, format (77 files), mypy changed module and diff whitespace checks passed. Container build/import and health checks passed.
- verify: regression tests first reproduced blocking reader pins and three redundant accounting sweeps, then passed after the changes. Disk limits, cancellation, concurrent readers and representation integrity retain behavioural coverage.
- verify: production Chrome, diagnostic account and `X-Soundspan-Diagnostic: playback`: 20 successful starts (10 playlist, 10 Wave), 47.5–2479.1 ms to `playing`, around 3 s verified progress per start, no media errors. The playlist pass used `cefb5570`; the final Wave/rapid-switch pass used `f0aed1dd`. This is a prepared/mixed cohort, not 20 unique cold songs.
- verify: three rapid Next clicks 250 ms apart → ready in 2362 ms; two Previous clicks → 1828 ms. Seek to 98.6/197.8 s continued to 101.6 s without a reset. These are browser events/time progression, not physical acoustic capture.
- verify: one SSH channel stopped for a bounded fault check; three new YouTube requests through the other channels returned 200 in 0.518 s total. The stopped channel was restored and its SOCKS handshake verified. This does not test transparent recovery of an in-flight stream killed with that channel.
- verify: all 15 production containers healthy; 13 neighboring container IDs unchanged. Final public `/api/health` healthy, PostgreSQL/Redis 2 ms. No taste/history writes by diagnostic requests.

## Deployment and rollback

Only `soundspan-prod-ytmusic` and its namespace-sharing `soundspan-prod-pot-provider` were recreated. The PO provider must be force-recreated after changing the YouTube container; a healthy old container can otherwise retain the previous namespace.

CT121 service units: `soundspan-egress-pool.service`, `soundspan-egress-pool-http.service`, and `soundspan-egress-pool-{1,2,3,4}.service`, all enabled. Configuration is under `/opt/soundspan-egress-pool`. The private HTTP listener is `172.30.121.9:18122`; source ACLs retain the original audio-egress restrictions. SSH uses the existing dedicated key and strict host-key checking; no secrets are recorded here. The former `172.30.121.9:18118` route is unchanged.

Active compose overlay: `/srv/music/soundspan-releases/b0-b340a7c/compose.json`.

Rollback choices (inspect the selected backup before applying):

- Last sweep change only: `/srv/music/soundspan-releases/cold-sweep-f0aed1dd-85kjvezw/compose-before.json` restores `cefb5570` with four channels.
- Four-channel route only, retaining the first runtime release: `/srv/music/soundspan-releases/cold-release-5398e3eb-b79km_j0/compose-before-pool.json` restores `5398e3eb` with the original single SSH route.
- Entire change set: `/srv/music/soundspan-releases/cold-release-5398e3eb-b79km_j0/compose-before.json` restores the pre-change image, route and limits.

Restore the selected overlay with mode 0600. Use the current container's `com.docker.compose.project`, `project.working_dir`, `project.environment_file` and `project.config_files` labels to preserve the full compose invocation. Run `config -q`, then `up -d --no-deps ytmusic-streamer`; wait for healthy, then `up -d --no-deps --force-recreate ytmusic-pot-provider`; verify health and `NetworkMode == container:<current YouTube container ID>`. Do not restart the whole project or print the environment file. Keep the pooled units alive until the sidecar has actually switched away from them.

The initial experimental direct-proxy release script is superseded; do not rerun it. Direct TCP/HTTP egress and the WireGuard experiment were rejected after route instability and are stopped/disabled. No default route, neighboring VPN service or router firewall was changed.

## Remaining operational risk and evidence

Paired packet captures observed repeated SYNs leaving the LAN but absent at the Germany host. This localizes loss to the intervening path, not to a particular router/provider and not to YouTube load limits. Multiple persistent channels mitigate shared stalls; they do not repair that path or guarantee future provider availability/CAPTCHA behavior. A longer soak and a public-edge/device test remain separate capacity evidence.

The 19 stopped canary containers and their isolated cache directories were removed after exact target checks, reclaiming 1,695,641,293 bytes of temporary data. Production cache, user files, current/rollback images and release backups were retained.

Production reports: backend `/app/logs/cold-production-1788953400245.json`, `cold-production-1788954089093.json`, `cold-production-1788954642321.json`; matched egress baseline `cold-production-1788949740851.json` and `cold-pool-*.json`. Local artefacts in the sibling `soundspan/output`: `cold-acceptance-final.json`, `playwright/cold-browser-final.json`, `cold-release-review.md`, bounded load/deployment/failover/cleanup scripts. No bearer tokens or signed media URLs are retained in these reports.
