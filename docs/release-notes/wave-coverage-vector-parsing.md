# Wave coverage and vector parsing

Baseline: `681680db`, deployed runtime `20608c8e`. Scope: measured analysis coverage for sparse Wave accounts and the next recommendation latency bottleneck. Hybrid remains 50%; no recommendation-weight, schema or listening-history change.

## Findings and change

The analysis queue was empty, with no orphaned processing rows, 544/750 daily reservations used and no active asset leases. Saved recordings were already analyzed almost completely: 304/307 for Dartum, 95/95 for someclade, 16/16 for laurisoul and 26/27 for agentik007. Several sparse accounts had no saved tracks. The six-hour background sweep and its durable saved/listened signals do not continuously admit every diagnostic discovery candidate. The observed missing coverage was not proof of a stuck model or exhausted budget.

A fixed selection from the previously captured real Wave queues was saved before admission: Attela7 22 canonicals (6 analyzed), TochnoRatatyi 13 (3 analyzed), Pivozavr454 15 (11 analyzed). A bounded explicit pass submitted only these candidates to the normal scheduler and queue. Account eligibility, completion/cooldown, leases, daily budget and concurrency guards remained enabled. Optional MusicBrainz enrichment was omitted for this audio-only pass; no diagnostic plays, likes or recommendation generations were created. Existing completed analyses were not reset.

Fresh CPU profiling identified about 1.1 seconds of vector parsing across eight diagnostic feeds, including per-coordinate conversion callbacks. `parseEmbedding` uses native JSON numeric parsing for finite non-empty numeric arrays, with the original compatibility parser retained for other accepted input forms. No persistent cache, user result reuse, numeric approximation or vector-model change was introduced.

## Verification

- verify: resource regression RED at 514 `trim` calls for a 512-dimensional vector; GREEN at no more than two. Existing malformed-input checks and compatibility/negative-zero tests pass.
- verify: targeted embedding and feature-store tests: 42 passed; backend build passed.
- verify: 544 captured production vectors parse to exactly the same numbers, with additional invalid and legacy-format parity cases. In alternating local repetitions the old parser took 55–66 ms and the candidate 19–21 ms after warmup. This microbenchmark does not establish HTTP capacity.
- verify: fresh pre-change diagnostic HTTP p95: 10 = 2,458 ms; 25 = 4,312 ms; 50 = 9,780 ms. No HTTP errors, no degraded sources. Further load stopped at the 5-second threshold. Four account contexts, two bursts per stage, internal frontend → backend; no isolated test container or extra analysis batch was running during this baseline.

## First release and the remaining bottleneck

verify: `1d48d2fb` was released only to API/worker; runtime module hashes matched, 13 neighbors were preserved, and the pre-release database archive passed its listing check. Full Linux gate: 597 suites, 8,488 passed, 7 skipped, zero failures; line coverage 94.55%.

verify: with the parser release, HTTP p95 was 2,050 / 4,115 / 7,912 ms for 10 / 25 / 50, with no errors or degraded sources in measured stages. The first warmup reported optional `dclap-mood` degradation; later warmups/stages recovered. The 50-request stage still failed the latency threshold, so 100 was not run. This intermediate result does not satisfy the target.

A second profile showed vector normalization as the next significant CPU cost. Finite-value checking and squared-norm accumulation share one coordinate pass; sparse-array skipping, summation order and division are preserved. Mood/session vectors are normalized once at the public ranking entrypoint and reused by scoring, fallback and exploration. This is local preparation, not a cache between requests. A broader rewrite of centroid loops failed to show a consistent improvement and was discarded.

verify: RED/GREEN tests reduced raw-vector reads 1,536→1,024 for 512 dimensions and shared-vector reads 5,760→192 across 30 candidates. Recommendation suites: 339 passed, 4 skipped. Exact comparisons: 201 centroid cases including sparse/invalid/overflow vectors, 300 ranking comparisons including invalid/shared session vectors and input mutation, plus all eight captured production rankings and scores. Alternating local warmed centroid runs on 500 vectors ranged 26–41 ms before and 14–17 ms after; HTTP acceptance remains separate.

verify: all fixed cohorts completed scalar analysis and embeddings: 22/22, 13/13 and 15/15, with no new failures. This is 30 newly analyzed account/canonical entries in the same saved cohort, not a percentage derived from a changing catalog. A subsequent 36-scenario replay retained the checked exclusion/diversity invariants; two requests degraded on optional DCLAP mood lookup. New candidate supply still limits mood differentiation in two sparse accounts. Analysis completion is not subjective listening acceptance or full coverage of newly arriving recommendations.

## Normalization release and repeated-work profile

verify: `ec99f78f` passed the full Linux gate (597 suites, 8,490 passed, 7 skipped, zero failures; line coverage 94.55%) and was released only to API/worker after a checked database backup. All 13 neighbors were preserved. HTTP p95 at 10 / 25 / 50 was 1,599 / 3,809 / 7,880 ms, without measured-stage errors or degraded sources. The 50-request threshold still failed; 100 was not run. A real audio range returned HTTP 206, audio/webm and 65,536 bytes in 92 ms. Diagnostic requests left recommendation generation/exposure counts unchanged.

Profiling the actual API process during 25 concurrent requests identified repeated parsing (1,577 ms sampled CPU) and taste-centroid construction (1,492 ms, plus 214 ms in its callback). The temporary inspector bound only to container loopback and was closed after collection; port closure was checked.

## Exact-content computational reuse

Standard 512-dimensional vector parsing now retains up to 2,048 exact text inputs, each at most 16,384 characters. Taste-centroid results retain at most 32 normalized input matrices, with a combined key budget of 16,777,216 UTF-16 code units. The latter key contains every IEEE-754 coordinate in order and the actual cluster count, rather than a hash or an account identifier. Legacy dimensions and unusual inputs keep the uncached path. Ranking scores, candidate selection and centroid arithmetic remain unchanged.

Both stores return independent copies and use least-recently-used eviction. Re-analysis, preference changes, ordering changes and changed cluster counts naturally produce the appropriate new input. No recommendation response, session state or account history is reused. Conservative retained payload bounds are about 72 MiB for parsed vectors and 33 MiB for centroids, excluding object/map overhead; actual retention depends on the working set.

verify: resource tests were RED before reuse and GREEN afterward. Checks cover modified returned arrays, changed inputs/counts, parser eviction after 2,049 distinct inputs, centroid eviction by both 32-entry and total-key limits, and uncached legacy behavior. The current focused run passed 359 tests with 4 skipped; backend build passed. Full gate, exact compiled-artifact comparisons and final HTTP acceptance follow below.

## Final verification and release

verify: final code `67eb3990` passed the full Linux coverage gate: 597 suites, 8,495 passed, 7 skipped, zero failures; line coverage 94.55%. Gate artifacts: `/srv/music/soundspan-releases/coverage-reuse-verify-f93saquc`. Ordinary and separate adversarial reviews found no blocking defect. Exact comparisons include 544 production vector parses, 201 centroid cases, 300 ranking cases, eight complete production rankings, and 426 additional cache-boundary/mutation comparisons against `ec99f78f`.

verify: images `local/soundspan-backend:reuse-67eb3990` and `local/soundspan-backend-worker:reuse-67eb3990` were deployed on 10 September 2026 MSK. The two runtime hashes match the packaged local build in both containers:

- `utils/embedding.js`: `1ff13adce9d79fe93629ae71df7b3b4b5ea25b4ccd1812bd5100ace709ef7ab9`
- `services/recommendations/rankerV2.js`: `37ffaf847081db9f3dc822525c97ff5d85d8a7f19e972d33c49b2c78f7a6971b`

verify: all 15 containers are healthy, with the 13 neighboring container IDs preserved. Public HTTPS health returned 200 and healthy dependencies. A real prepared HIGH audio range through frontend returned 206/audio-webm, 65,536 bytes in 121 ms. This checks byte delivery, not physical listening or new cold-playback capacity. Hybrid remains 50%.

Rollback artifacts are under `/srv/music/soundspan-releases/coverage-reuse-67eb3990-h95m_caq/backup`: `compose-before.json`, `soundspan.dump`, and its SHA-256 file. The 21,735,538-byte custom-format archive passed `pg_restore --list`; no full restore drill was performed. Restore the saved overlay, validate the existing compose configuration and recreate only `backend backend-worker` with `--no-deps` to return to the retained `centroids-ec99f78f` images. Application rollback requires no database restore or deletion of completed analysis results.

## HTTP acceptance and remaining work

verify: the final run used the same diagnostic HTTP path through frontend, four account contexts, fixed session identifiers and two bursts per stage. No isolated test container or additional analysis batch ran during either benchmark.

| Simultaneous requests | Initial p95 | Final p95 | Final HTTP errors |
| --- | --- | --- | --- |
| 10 | 2,458 ms | 1,663 ms | 0/20 |
| 25 | 4,312 ms | 3,404 ms | 0/50 |
| 50 | 9,780 ms | 6,855 ms | 0/100 |
| 100 | Not run | Not run | — |

The 50-request p95 improved by about 30%, but still fails the 5-second target. Its measured stage also reported optional `canonical-identity` degradation; the first warmup reported `dclap-mood`, then recovered. Therefore the accepted stage remains 25, and load was not escalated to 100. This is a short internal HTTP benchmark across four accounts, not 50 distinct listeners, sustained throughput, or public TLS capacity. Generation/exposure counts stayed at 2,000/61,133 throughout both benchmark runs.

verify: the final 36-scenario replay for the three sparse accounts has no checked exclusion/diversity violations and no degraded sources. However, current discovery candidates may differ from the saved analysis cohort: Attela7's new Hybrid discovery selection has 0/12 analyzed, while all 22 saved cohort entries remain analyzed. Completing the fixed cohort does not ensure coverage of a continuously changing catalog. TochnoRatatyi and Pivozavr454 still have identical Calm/Energetic mean intensity, so subjective quality and broader candidate supply remain open.

Three successive latency changes reduced duplicated work but did not make the 50-request stage pass: parser `1d48d2fb` = 7,912 ms; normalization `ec99f78f` = 7,880 ms; bounded reuse `67eb3990` = 6,855 ms. At the repository's three-attempt escalation checkpoint (`AGENTS.md`, Debugging Protocol), the user explicitly authorized continued optimization. The next investigation will separately measure remaining API CPU, database waits and canonical-identity timeouts on the current release before choosing another change. No cause for the residual latency is claimed as proven.

Consolidated local evidence: `soundspan/output/coverage-final-acceptance.json`; detailed diagnostic logs remain under backend `/app/logs/coverage-*`. Code is committed locally; no git push was performed.
