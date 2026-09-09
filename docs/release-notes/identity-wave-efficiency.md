# Identity enrichment and Wave efficiency

Baseline: `4822596c`. Scope: canonical mapping diagnosis, optional MusicBrainz identity enrichment, Wave quality validation and recommendation latency. No schema, analysis model, history, rollout percentage or audio-path change.

## Diagnosis

- The inspected active mapping set contained 8,307 rows, 1,449 without a canonical link and no provider linked to multiple distinct canonicals. New-candidate resolution produced retried serializable conflicts, but the sampled feeds completed without canonical-identity degradation. Missing canonical links alone do not prove corruption or authorize bulk relinking.
- MusicBrainz experienced TLS resets, timeouts and upstream 503 responses. Read-only probes through the configured HTTPS proxy returned real recording metadata and one real search response; another search timed out. Direct DNS/TLS differed, but the application already uses the proxy, so no DNS or routing change is justified by those direct probes.
- Concurrent optional identity batches could enqueue repeated work for the same recording and exceed their per-batch limit across accounts. A controlled two-account test reproduced 51 lookups where one shared 25-record bound was intended.
- CPU profiling identified repeated diversity normalization/comparison and embedding parsing. The diversity resource regression test observed 8,801,280 vector element reads for 60 candidates and a 36-track queue.

## Implementation

- Diversity preparation and accumulated maximum similarity are local to one ranking pass. There is no cache of user preferences or completed recommendations. Exact scores, stable ordering, exclusions, cooldown fallback, exploration and quotas remain unchanged.
- The identity enricher owns up to 25 pending canonical lookups per process. Duplicate work is shared, failure releases its slot, and excess work remains eligible for a later pass. This does not impose a new cross-process rate limit or claim permanent provider availability.
- Optional metadata and its follow-up ISRC lookup retain the existing MusicBrainz queue, receive lower priority and perform one network attempt. Existing 120-second failure caching defers subsequent attempts. Interactive requests retain their retry behavior; ambiguous matches are still rejected.

## Verification

- verify: targeted backend recommendation/provider tests: 414 passed, 4 skipped; backend build passed.
- verify: eight captured ranking inputs from four production accounts preserve every selected track and exact score. Separate adversarial comparisons cover 300 ranking calls with duplicate identities, invalid vectors, quota pressure, cooldown fallback, exploration and input mutation between calls.
- verify: baseline diagnostic HTTP requests through internal frontend to backend: 10 simultaneous requests, two rounds, zero HTTP errors, p95 7,538 ms. Further steps stopped at the 5-second threshold. This is four account contexts, not ten distinct people.
- verify: full Linux coverage gate under the non-root application user: 597 suites passed, 8,486 tests passed, 7 skipped, zero failures. Line coverage 94.55%. The first root-run exposed a permission-test environment mismatch and a cold API-test timeout; rerunning with the correct user and two workers/four CPUs resolved both without changing tests or timeout values.
- verify: normal review and a separate adversarial pass found no blocking issue in the three runtime modules.

## Quality boundaries

At the initial snapshot, 2,770 live canonical recordings had completed scalar analysis and 2,768 had completed embeddings. Of the completed scalar rows, 666 used the central-fragment model version and 2,104 retained the older version. The snapshot is not a fixed user cohort, and older versions are not automatically incorrect.

Observed Wave outcomes after the prior release did not include comparable served baseline and Hybrid sessions within the same account. Hybrid remains at 50%; neither expansion nor removal is supported by these observations. Subjective quality still needs ordinary listening, which diagnostic requests must not fabricate.

## Production acceptance

Runtime commit: `20608c8e`. Only API and worker were recreated using `local/soundspan-backend:identity-20608c8e` and `local/soundspan-backend-worker:identity-20608c8e`. Each image extends its exact deployed predecessor with the three verified JavaScript modules. Runtime SHA-256 values match the built files in both containers.

verify: comparable diagnostic HTTP load uses four account contexts, the same session IDs and alternating Calm/Energetic requests through internal frontend → backend. Each stage contains two simultaneous bursts. The isolated coverage container was absent during both load runs.

| Concurrent requests | Before p95 | After p95 | After errors / requests |
| --- | --- | --- | --- |
| 10 | 7,538 ms | 2,231 ms | 0 / 20 |
| 25 | Not run: threshold exceeded at 10 | 4,412 ms | 0 / 50 |
| 50 | Not run | 8,776 ms | 0 / 100 |
| 100 | Not run | Not run: threshold exceeded at 50 | — |

The measured 10-request p95 improved by about 3.4×. The accepted stage under the 5-second threshold is 25; 50 remains too slow. These are logical HTTP requests across four accounts, not distinct listeners, public-TLS load or a long soak. All successful responses retained at least 21 shelf entries and reported no degraded source. Before and after load each left generation/exposure totals unchanged at 2,000 / 61,133.

verify: frozen account-data replay covered 144 scenarios across 12 non-test accounts: baseline and Hybrid, default/Calm/Energetic/Focus/Workout, plus Discoveries. All scenarios returned tracks. No checked queue contained duplicate provider IDs, a canonical exposed in the preceding 24 hours, a disliked canonical, an item longer than 15 minutes, or more than two tracks by one display artist. Discoveries contained no liked track by the checked provider/canonical identity. Canonical resolution can still persist metadata and retry serializable conflicts; diagnostic isolation prevents taste/generation/exposure writes, not every database write.

For the four main account contexts, mean analyzed arousal in Hybrid Calm → Energetic was 0.326 → 0.834, 0.397 → 0.804, 0.602 → 0.719 and 0.666 → 0.755. These are model outputs, not listening judgments. Coverage remains uneven: analyzed Discoveries range from 0/12 to 11/12 across accounts, and two accounts had identical Calm/Energetic means. A small or poorly analyzed candidate pool still limits differentiation. This audit does not close subjective quality acceptance or claim full analysis coverage.

verify: analysis telemetry at 2026-09-09 22:54 UTC reports 2,776 completed scalar analyses, 528 completed in the preceding 24 hours, and 2,799 recordings with vectors in the active embedding space, 550 in the preceding 24 hours. There are 25 active leased assets; configured execution concurrency remains 2, daily budget 750 with 544 reservations used. Active leases do not mean 25 simultaneous model executions. Processing is enabled and progressing; no bulk reset or concurrency increase was applied. Active-space vector existence and the earlier embedding-status snapshot are different metrics.

verify: public `/api/health` returned HTTP 200 with PostgreSQL/Redis healthy. An authenticated diagnostic HIGH stream through frontend returned HTTP 206, `audio/webm`, exactly 65,536 bytes in 89 ms. This is a short prepared-stream probe, not a new cold-load or physical-audibility test. All 15 containers were healthy after acceptance; the 13 neighboring container IDs were preserved. Runtime Hybrid rollout is 50%.

## Backup and rollback

Release directory: `/srv/music/soundspan-releases/identity-wave-20608c8e-_6hkgczl` on CT121. `backup/soundspan.dump` is a 21,335,469-byte custom-format PostgreSQL backup, verified by `pg_restore --list`, with its SHA-256 saved alongside it. This validates the archive listing, not a full restore rehearsal. `backup/compose-before.json` preserves the previous deployment overlay; old API/worker images remain available.

To roll back the application, restore that overlay to `/srv/music/soundspan-releases/b0-b340a7c/compose.json`, validate the Compose configuration using the existing live project labels, and recreate only `backend backend-worker` with `up -d --no-deps`. Verify readiness, the public health endpoint, diagnostic recommendations and an actual audio range afterward. There is no schema migration, so an application rollback does not require restoring the database or discarding later user activity.

Evidence: backend `/app/logs/identity-wave-{load-before,load-after,quality,smoke,progress}.json`; local `soundspan/output/identity-wave-acceptance.json`; isolated full-test evidence `/srv/music/soundspan-releases/identity-wave-verify-cvtdx13i/verify-corrected.log` and its backend coverage JSON. Git push was not performed.

Remaining work is bounded by the measured findings: continued ordinary analysis and real listening outcomes for sparse accounts, MusicBrainz upstream availability, and another evidence-backed CPU optimization before reconsidering the rejected 50/100-request stages. No recommendation-weight or rollout change is justified by this performance release.
