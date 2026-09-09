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
