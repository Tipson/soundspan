# Wave coverage and vector parsing

verify: final retained production artifact is `prefix-a815af55`. The **50-request target is met**: p95 **4,510 ms**, versus this cycle's fresh keys-dfb61aa8 baseline of **5,760 ms** (about 22% lower in this run). At 10/25 requests, p95 is 1,330/2,737 ms versus 1,311/2,961 ms. The next 100-request stage completed without HTTP errors but had p95 **10,068 ms**, so it is not accepted at the <=5-second threshold. All measured stages had zero degraded sources. These are two short bursts per stage, through the internal frontend in four account contexts with fixed request parameters; they do not establish sustained capacity or 50 distinct listeners. Production data changed between checkpoints, and returned candidate counts varied; exact computation parity was checked separately in read-only snapshots.

verify: backend build and the full gate passed: **598 suites, 8,519 passed, 7 skipped, zero failures, 94.56% lines** at `/srv/music/soundspan-releases/coverage-prefix-verify-q70xmciz`. Runtime hashes match in API/worker; all 15 containers are healthy, and release preserved 13 neighbors. Public health returned 200, four final diagnostic Wave feeds returned 200 without degradation, and prepared audio returned 206/audio-webm/65,536 bytes in 33 ms. The first release warmup reported optional DCLAP mood degradation, then recovered. Generation/exposure counts stayed 2,016/61,495 during the accepted load and final smoke. Hybrid remains 50%, API/worker pools remain 8/4, and the inspector is closed. No push.

This cycle rejected the pool increase and retained the vector-cache lookup change. The agreed 50-request checkpoint is complete; 100-request latency, changing discovery coverage and subjective listening acceptance remain open. No third optimization attempt was needed for the 50-request target. Historical results below describe their own checkpoints, not the current deployment.

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

## Reuse checkpoint verification and release

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

## Continued optimization: saved-profile lookup

The user explicitly authorized continued latency work. A fresh API/driver profile at 25 concurrent requests found 1,561 pooled query acquisitions across 54 HTTP requests, with up to 84 pending acquisitions and 404 ms p95 pool wait. The pool remained at its configured eight connections. SQL execution plans identified a correlated saved-profile lookup checking 2,837 analyzed canonical recordings and roughly 2,950 provider/like matches even for an account with only 16 saved vectors.

`loadLikedTasteEmbeddings` now starts from the current account's indexed local/YouTube/Tidal likes. The three branches retain actual provider-row joins and non-stale mappings; UNION deduplicates canonical identities across providers. Merged identities, cleaning/inactive embedding spaces, ordering and the 500-record cap keep their prior semantics. Bound SQL parameters include the account in every branch. The existing vector-loading and scoring functions are unchanged. No schema, index, connection-pool, cache-policy or experiment change is required.

verify: focused regression tests were RED before the query change and GREEN afterward. Recommendation suites: 343 passed, 4 skipped; backend build passed. SQL extracted from the final compiled artifact returned exactly the same ordered canonical IDs as the previous generated query for all 13 current non-test accounts in a read-only repeatable-read transaction. Measured server execution was 38.963–115.492 ms before and 0.114–17.445 ms afterward; shared-buffer accesses fell from about 18,000–24,000 to 5–1,697. These query measurements are not HTTP acceptance.

verify: a separate 900-record PostgreSQL fixture covered local/YouTube/Tidal overlap, quoted account IDs, another account, missing provider rows, missing canonical mappings, stale mappings, null/merged identities, absent/retired/cleaning vectors, tied timestamps, the exact 500-record limit, unlike operations and mapping changes. All 12 ordered-result comparisons matched. Fixture tables were session-local and rolled back; no persistent tables were changed. The fixture was rerun with representative indexes and a 30-second statement timeout after the initial unindexed reference query became too slow and was cancelled by its verified backend PID/query prefix.

Full gate and the new HTTP acceptance follow after this checkpoint.

verify: `a7b69c98` passed 597 suites, 8,496 tests, 7 skipped, zero failures, line coverage 94.55%, and was released only to API/worker. Runtime `featureStore.js` SHA-256 is `748c00da749e2474826607aeb67ccdfb39bd0509b42131cb5cffbd517f43c818`. Backup root `/srv/music/soundspan-releases/coverage-liked-a7b69c98-29aa03v_`; the 21,740,152-byte dump passed its listing/hash checks. All 13 neighbors were preserved. HTTP p95 at 10/25/50 was 1,582/3,287/6,228 ms, with zero errors/degraded sources. The 50-request target still failed; 100 was not run. Public health200 and a real audio range (206, 65,536 bytes, 147 ms) passed; diagnostic history counts remained unchanged.

## Discarded bounded SQL projection candidate

The earlier CPU profile also identified significant Prisma relation assembly, including repeated playback/collection track joins. Candidate `1853e835` projected the selected track fields with PostgreSQL `row_to_json`, retaining the original parent filters, ordering and limits: 1,000 plays and 2,000 likes/playlist entries. It was not deployed: final repository-contract review found that ordinary relational reads must use Prisma. The earlier saved-profile SQL change is also reverted by the replacement release below. No relationJoins preview flag or global ORM behavior was enabled.

verify: the query-boundary regression was RED before the change and GREEN afterward. Targeted catalog/recommendation tests: 385 passed, 4 skipped; backend build passed. Both compiled implementations returned deeply equal complete signal objects for all 13 real non-test accounts within a read-only repeatable-read transaction, including Date values, nullable fields, arrays and order. Actual driver calls for this module fell from seven to four per load. Six alternating eight-request microbenchmarks measured 111–278 ms before and 61–138 ms after; every paired elapsed-time result improved, but CPU timings varied and do not establish HTTP capacity.

verify: six additional comparisons on session-local PostgreSQL tables with 2,505 source rows cover limits, tied timestamps/sort positions, missing track and playlist relations, null/unknown playback observations, Unicode/quoted text and account identifiers, another/absent account, removed likes, changed track metadata and playlist ownership transfer. Complete signals remained equal. The temporary relations were isolated to one transaction and dropped on completion; only the verification process rewrote generated model SELECT namespaces to those temporary tables. No persistent data or schema changed. Full gate and HTTP acceptance are pending for this candidate.

## Prisma batch replacement

The SQL prototype passed its isolated tests but was rejected before deployment because it violates the repository rule for ordinary relational reads. The saved-profile lookup returns to the previous Prisma implementation. The replacement reads bounded parent signals through Prisma, then fetches their distinct track metadata once, using a request-local map and separate result copies. It preserves parent ordering, limits, missing relations and fresh reads; no shared account cache, schema, index or global ORM option changes.

verify: RED/GREEN tests cover the shared metadata query, scoped source queries, duplicate/missing track references, legacy empty string IDs and older likes. Focused tests: 382 passed, 4 skipped; backend build passed. Both complete signal objects matched for all 13 non-test accounts in a read-only repeatable-read transaction; driver calls were seven before and five after. Six comparisons on the 2,505-row temporary-table fixture also matched before/after unlike and ownership changes. In six alternating eight-request microbenchmarks, five pairs improved (before 145–442 ms; after 107–210 ms); one pair regressed, so HTTP latency remains unproven. Full coverage and release results follow below.

verify: Prisma batch `b00035a9` passed the full gate (597 suites, 8,496 passed, 7 skipped, zero failures, 94.56% lines) and was released only to API/worker. Backup root: `/srv/music/soundspan-releases/coverage-batch-b00035a9-ikeq7zwk`; checked dump 21,751,397 bytes, SHA-256 `19705a51d8be082aacd4b9b3a9efc127f87ccabda9c29889ec9f16706364dfaf`. All 13 neighboring IDs were preserved. HTTP p95 at 10/25/50 = 1,475/2,938/5,624 ms, zero measured errors/degraded sources. One initial warmup reported `dclap-mood`; subsequent warmups recovered. The 50-request threshold still failed and 100 was not run. Audio returned 206/audio-webm/65,536 bytes in 91 ms; history remained 2,000/61,133 and Hybrid 50%.

## Concurrent candidate and account reads

The engine's candidate adapters and account context have no data dependency, but the previous request path read them sequentially. Both are started together and joined before canonical resolution/ranking. Promise.all observes both failures immediately, including a candidate failure while optional profile reads are pending. Each context remains request-local and is loaded once; Wave keeps its exclusion policy, baseline Home still skips these reads, and experiment assignment/persistence are unchanged. Account context is read nearer the request start; this does not provide a transaction snapshot across concurrent user feedback, just as the old multi-statement path did not.

verify: controlled deferred-promise tests were RED before this change and GREEN afterward for baseline/active/shadow Wave. They also cover baseline Home and a late optional rejection after an early candidate failure, with no generation/hot-set write. Targeted tests: 387 passed, 4 skipped; backend build passed. Exact compiled-artifact comparisons and full-gate acceptance follow below.

verify: the final compiled engine was replayed against eight captured real-account dependency traces (four accounts, Calm/Energetic). Complete responses, scored rankings, served/shadow experiment records, call arguments and call counts matched exactly. All account context reads occurred once. The probe used diagnostic persistence stubs and unchanged history counts (2,000 generations / 61,133 exposures); its temporary method override was confined to the standalone verification process and restored afterward.

## Concurrent-read result and rollback

verify: `0e58dc55` passed 597 suites, 8,501 tests, 7 skipped, zero failures (94.56% lines), build and exact replay checks. Gate: `/srv/music/soundspan-releases/coverage-overlap-verify-mltr3a6c`. The API/worker-only release preserved 13 neighbors. Checked backup: `/srv/music/soundspan-releases/coverage-overlap-0e58dc55-bisyd2l2/backup`, 21,752,478 bytes, SHA-256 `f1c84c5546094e010ea42f32a00c4fe46f6cd8400e9cfaee7f92da4e01e1cc37`.

verify: its HTTP p95 at 10/25/50 was 1,383/2,777/5,866 ms, with zero measured errors or degraded sources. The initial warmup reported `dclap-mood`, then recovered. At 50 the result was worse than the prior 5,624 ms, and still exceeded 5 seconds. The experiment was rejected, 100 was not run, and the engine change and its candidate-only tests were reverted. This does not prove the exact cause of the regression; simultaneous pool/CPU contention remains a hypothesis.

verify: production was rolled back to retained `batch-b00035a9` images using the saved compose overlay. Both API/worker became healthy and all 13 neighboring IDs remained unchanged. Restored hashes in both containers: engine `c2604f70d47098c0d721fdcb611af0698c2b753c8993d35fc16c7678d4bb4027`, catalog `0b4a09618cf5f23a7f6cb4d71060bcaba474a0f89479919f040910cfd0e508d5`, feature store `794b4561d131e932e0c6f7451cb8e579e3e7d973c62cbbb0d29694d86098c433`. No database restore or analysis deletion occurred. Final source under backend is identical to b00035a9; restored-artifact validation follows below.

After the user's renewed authorization, three deployed attempts measured 6,228 ms (saved-profile SQL, later replaced to comply with Prisma rules), 5,624 ms (Prisma metadata batching), and 5,866 ms (concurrent reads, rejected and rolled back) at 50. The best retained variant improves the previous 6,855 ms checkpoint by about 18%, but the <=5-second goal remains unmet. Further code attempts pause under AGENTS.md's three-attempt rule pending user direction; the accepted measured load stage remains 25. Fixed-cohort analysis completion remains 50/50, while changing discovery coverage and subjective listening quality remain open.

## Provider-separated Prisma lookup

The user authorized a third optimization cycle. A fresh unchanged-runtime baseline measured HTTP p95 at 10/25/50 of 1,815/3,765/8,217 ms, with no measured-stage errors or degraded sources. The prior 5,624 ms checkpoint was taken earlier and is not the current paired baseline. The actual API/driver profile at 25 requests recorded 375 ms p95 connection acquisition and 88 pending acquisitions. The combined-provider saved-profile query accounted for 8,819 ms of client-observed elapsed time across 54 calls; this includes client wait and is not pure database execution time.

Moving the provider OR to a different nesting level preserved all 13 account results but did not improve PostgreSQL plans and was discarded before changing application code. The retained candidate uses one bounded Prisma canonical query for each provider, then asks PostgreSQL to order and cap the deduplicated union. At most 1,500 intermediate IDs and 500 vector results are admitted; filtering, collation and account scope remain unchanged. No schema, pool or cache changes are included.

verify: generated-query EXPLAIN probes measured aggregate execution for the four candidate queries at 0.184–16.776 ms versus 38.58–115.71 ms for the original query, with buffer accesses falling from roughly 18,000–24,000 to 5–3,206. Complete vectors and ordered canonical parameters from the compiled module match for all 13 real accounts. Twelve more comparisons on 1,800 session-local canonical rows cover overlapping providers, limit/ties, invalid relations/spaces, account isolation, unlike and remapping. These are database/correctness results, not HTTP capacity acceptance.

verify: revision `86bb0938` passes backend build, formatting and focused tests (360 passed, four skipped). Ordinary and separate adversarial review found no blocker. Runtime provider reads use separate read-committed statements; parity was measured on a stable repeatable-read snapshot and does not imply atomic profile snapshots during concurrent preference updates. The full gate and release/HTTP results follow below.

verify: `86bb0938` passed the complete Linux gate at `/srv/music/soundspan-releases/coverage-provider-verify-3dwngs1m`: 597 suites, 8,496 passed, seven skipped, zero failures, 94.56% line coverage. API/worker runtime SHA-256 is `776efed2d5487e32a14c60285039c2d622f89816a31880c7549845f82e770442`. Release root `/srv/music/soundspan-releases/coverage-provider-86bb0938-8ofczhpq` contains the saved overlay and checked 21,767,574-byte database archive (SHA-256 `a101ac59a52ab6decdb69fff88337a0db9298f4bf77b1450416f5b94f85c6b14`). All 13 neighbors were preserved; all 15 containers are healthy.

verify: the identical HTTP run measured 1,535/2,939/6,228 ms p95 at 10/25/50, versus the fresh baseline 1,815/3,765/8,217 ms. Measured stages have zero errors/degraded sources; the first warmup reported optional DCLAP mood degradation and later recovered. The 50-request stage improved about 24% but still fails 5 seconds, so 100 was not run. Generation/exposure counts remained 2,004/61,193 throughout both runs. Prepared audio returned 206/audio-webm/65,536 bytes in 82 ms; Hybrid remains 50%. Evidence: `soundspan/output/coverage-cycle3-acceptance.json`. This provider query change is retained while investigating the profiled normalization cost before the centroid cache lookup.

## Raw-input centroid cache lookup

The API profile sampled 948 ms in vector normalization across 54 diagnostic requests. The previous centroid cache looked up already normalized matrices, paying normalization on every hit. The candidate keys complete raw finite 512-dimensional input plus requested count before normalization; on a miss, it reconstructs plain arrays from the private packed copy for the unchanged normalization and clustering arithmetic. No cache count/key budget is increased. Invalid, sparse, legacy-dimension and unusual-count input retains the uncached path.

verify: RED/GREEN tests demonstrate 20 repeated square-root calls becoming zero on a cache hit and preserve sparse outer arrays. Final focused tests: 362 passed, four skipped; build passed. Exact compiled comparisons include 126 additional boundary cases, 201 centroid cases, 426 cache-boundary/mutation/parser checks, 300 ranking comparisons and eight captured production rankings with identical scores/order. In an isolated local run, 500-vector median hot-cache time was 4.652→2.607 ms and cold-cache time 31.965→31.954 ms. Earlier copying variants regressed cold timings and were discarded locally. This establishes a computation improvement, not HTTP acceptance; full gate and production measurements follow.

verify: `c937c242` passed the full Linux gate at `/srv/music/soundspan-releases/coverage-raw-verify-3noi1x7o`: 597 suites, 8,498 passed, seven skipped, zero failures, 94.56% lines. Read-only current-data comparisons also matched complete taste contexts for all 13 accounts. It was released only to API/worker with matched ranker hash `92808b9cb59e845d472ead20ab521985c4cf7a547b510a34e3368d5b2a5a0ddd`. Backup root `/srv/music/soundspan-releases/coverage-raw-c937c242-ee563t6i`; checked database archive 21,769,049 bytes, SHA-256 `50d6fcca08096bbf9ac98ea70c2b085327b336ee9dac3bc4a9a5a4dbfe8c0814`. All 13 neighbors were preserved.

verify: HTTP p95 became 1,441/3,129/6,950 ms at 10/25/50, versus retained provider 1,535/2,939/6,228 ms. Measured stages had zero HTTP errors/degraded sources; the first warmup reported optional DCLAP mood degradation, then recovered. The 50-request result regressed, so the raw-key optimization was rejected despite its passing correctness and computation tests. The cause of the HTTP regression is not separately established. Production and backend source were restored to provider-86bb0938; saved compose rollback recreated only API/worker and preserved all 13 neighbors. No DB restore, analysis deletion or schema change occurred. The restored ranker hash is `37ffaf847081db9f3dc822525c97ff5d85d8a7f19e972d33c49b2c78f7a6971b` in both containers.


verify: the restored final backend passed build and the complete gate again: **597 suites, 8,496 passed, seven skipped, zero failures, 94.56% lines**. Gate: `/srv/music/soundspan-releases/coverage-provider-restored-verify-afh_toht`. All 15 containers are healthy; feature-store, ranker and engine hashes match the restored artifacts in both API/worker. Public HTTPS health returned 200 with healthy dependencies. Four diagnostic Wave requests returned 200; the first reported optional DCLAP mood degradation, and a repeat for the same account returned without degradation. Prepared audio returned 206/audio-webm/65,536 bytes in 31 ms. Generation/exposure counts stayed 2,004/61,193; Hybrid remains 50%. Final backend source matches 86bb0938, restoration commit d59d6a02. No push. Consolidated evidence: `soundspan/output/coverage-final-acceptance.json`; cycle-only evidence: `soundspan/output/coverage-cycle3-final-acceptance.json`.

## Fourth cycle: repeated identity normalization

The user explicitly authorized the next cycle. verify: fresh retained-runtime p95 at 10/25/50 is 1,698/3,074/5,681 ms, with no warmup/stage errors or degraded sources. API profiling at 25 recorded 312 ms p95 pool wait and 112 pending acquisitions; the loopback inspector was restored and its closure verified. Sampled CPU includes 738 ms in vector parsing and 321 ms in artist normalization. The vector-return queries remain significant, but grouping repeated taste vectors only removed roughly 13–22% of payload for the heavy accounts and added SQL/serialization cost. That read-only prototype matched all 13 accounts and was discarded without a code change.

The candidate preserves NFKC, whitespace handling and en-US lowercase conversion exactly. It reuses the result for the complete primitive input string, admits at most 4,096 entries and at most 512 UTF-16 units for both input and output. The retained text payload is at most 8 MiB, excluding map/VM overhead. Hits refresh recency; overflow evicts the oldest quarter in one pass to amortize oldest-entry lookup under churn. No account identifier, recommendation response, history, metadata mapping or numeric score is cached.

verify: RED/GREEN tests cover repeated/empty results, changed inputs, Unicode cases, long input, NFKC expansion beyond the output limit, recency eviction and bounded eviction scans. The latter improved from 904 scans to one for 904 overflow insertions. Focused recommendation tests: 364 passed, four skipped; build passed. Final compiled comparisons match for 1,114,112 code-point values including lone surrogates, 5,000 random strings, eight complete captured rankings and artist/album/tuple keys of all 8,485 current YouTube catalog rows. Tidal has no current rows; Unicode and tuple behavior is provider-neutral.

verify: in the final server-side isolated microbenchmark, 20,000 repeated catalog names took 47–51 ms before and 9–10 ms after warmup. A deliberately unique-input stream remains slower: 79–94 ms before versus 98–111 ms after for 20,000 names; the initial one-at-a-time eviction version was substantially worse and was revised before release. This is a measured cache-miss overhead, and the live HTTP test determines retention. Ordinary and separate adversarial reviews found no correctness blocker; storage bounds and exact keys preserve account separation and fresh input behavior. Full gate and HTTP acceptance follow below.

## Fourth-cycle disposition

verify: retained dfb61aa8 passed the pre-release full gate (598 suites, 8517 passed, seven skipped, zero failures, 94.56% lines) and was deployed only to API/worker. Backup root: `/srv/music/soundspan-releases/coverage-keys-dfb61aa8-h9l0zu46`; the verified database archive is 21,772,477 bytes, SHA-256 `d41243b39fa0435a0d166097d8ba8c757bd73b847d63538eceb4f7f126d10391`. The saved compose overlay can restore provider-86bb0938 without a database restore. identityKeys.js SHA-256 is `b2f1a3c395b690d6b9d1f0cc27146fef9ebd04ce66d6cf701b3c16f2a32abcb5`.

verify: the third candidate replaced parsed-vector Map recency updates with bounded links. Tests reduced cache-hit Map mutations from two to zero; 20,558 comparisons preserved values, errors, cache misses and independent arrays. A temporary chain audit found no orphan entries, cycles or bound violations; all 13 live taste contexts matched. Focused tests passed 383 tests, four skipped, and build passed. But eight alternating server rounds on 544 real vectors showed no stable gain (3000 calls: old 43.14–91.93 ms, candidate 42.23–106.92 ms). The change and its candidate tests were restored to dfb61aa8 before deployment. The rejected patch and verification JSON remain in soundspan/output. Correctness did not substitute for performance acceptance.

verify: final retained production artifact is `keys-dfb61aa8`. In the identical four-account HTTP benchmark, p95 at 10/25/50 simultaneous requests changed from **1,698/3,074/5,681 ms** to **1,387/2,935/5,509 ms**. Measured stages had zero HTTP errors or degraded sources. The first release warmup reported optional DCLAP mood degradation, then recovered. The measured gain at 50 is about 3%; two short bursts do not establish significance or sustained capacity. The <=5-second target remains unmet; 100 was not attempted.

verify: the retained backend passed build and the final full gate: **598 suites, 8,517 passed, 7 skipped, zero failures, 94.56% lines**. Gate: `/srv/music/soundspan-releases/coverage-keys-final-verify-6q7btcj4`. Both API/worker runtime hashes match; all 15 containers are healthy and the release preserved 13 neighbors. Public HTTPS health returned 200. Four diagnostic Wave feeds returned 200; prepared audio returned 206/audio-webm/65,536 bytes in 31 ms. No final smoke feed reported degradation. Diagnostic generation/exposure counts stayed 2,004/61,193; Hybrid remains 50%. The inspector is closed. No push.

The fourth authorized cycle checked grouped vector transfer, exact identity-string reuse and linked recency for parsed vectors. Only identity-string reuse is retained; grouped transfer and linked recency showed no useful measured computation gain and were rejected before deployment. The fixed analysis cohort remains an earlier 50/50 result; dynamic discovery coverage and subjective listening acceptance remain open. The three-attempt checkpoint pauses further hypotheses pending user direction. A next cycle should separate database execution, pool wait and API CPU under the same workload before choosing another implementation or pool experiment.

Cycle-only evidence: `soundspan/output/coverage-cycle4-final-acceptance.json`; consolidated history: `soundspan/output/coverage-final-acceptance.json`.

## Fifth cycle: pool wait and vector lookup

The user authorized another cycle. verify: the fresh keys-dfb61aa8 baseline returned p95 1311/2961/5760 ms at 10/25/50, with no stage errors/degradation. The 25-request instrumented profile recorded pool-wait p95 346 ms and up to 93 pending acquisitions. API CPU was 12.35 seconds and event-loop utilization 78.9% over a 19.19-second interval including warmups and instrumentation. Client query time includes event-loop, transfer and deserialization delays. Read-only sequential EXPLAIN on captured parameterized queries measured the sample taste query at 31.7 ms and canonical features at 6.1 ms; these are isolated execution timings, not PostgreSQL timings under HTTP load. No server statistics settings were changed, and the inspector was closed.

verify: an API-only pool override 8→12 passed the existing adapter/config checks and preserved 14 neighboring containers, including the unchanged worker pool of four. It returned p95 1281/2961/5779 ms; the maximum at 50 grew to 6108 ms. The setting was rejected and the original overlay/API pool of eight restored with checked readiness. Backup: `/srv/music/soundspan-releases/coverage-pool-12-ic93hbk1/backup`; checked database archive 21,802,950 bytes, SHA-256 `c7c14c8c50510c6467a5c4b27e75b4f84a368b2c9699bae6c24aaf43ea06bc3c`. No DB restore or source edit was needed.

The next candidate changes only vector-cache lookup. It chooses a bucket from text length and a 64-character prefix, then requires exact full-text equality before returning a private copy. A collision is parsed and replaces that bucket; it never shares another vector's result. Storage remains at most 2048 vectors of 512 finite coordinates and at most 16384 characters per input. Invalid, oversized and legacy input paths retain their existing behavior. Prefix collisions can reduce cache hits, so the short key is not treated as a unique identity.

verify: the resource test was RED with a 10064-character Map lookup key, then GREEN with the bounded key. Equal-length inputs sharing their prefix, differing final coordinates, invalid tails and mutated output arrays remain isolated. Focused tests passed 383 tests, four skipped; build passed. Exact values/errors matched 20558 comparisons, and complete taste contexts matched all 13 real accounts in a read-only repeatable-read transaction. For 3000 calls on 544 real vector strings, eight alternating server rounds measured 43–59 ms before versus 8–24 ms after; all 544 sampled bucket keys were distinct. Ordinary/adversarial review and full HTTP acceptance remain separate from this computation result.

## Fifth-cycle acceptance

verify: the vector-cache candidate passed 24,000 additional collision/copy-isolation checks with retained storage bounded at 2048 entries. Ordinary and separate adversarial review found no correctness blocker. Full-text equality remains mandatory; prefix collisions only reduce reuse and cannot substitute another vector's values. The complete full gate passed before the release.

verify: release root `/srv/music/soundspan-releases/coverage-prefix-a815af55-b51sy3gb` contains the saved compose overlay and checked database archive (21,803,509 bytes; SHA-256 `12340f403cb846de5dffb7028467dd09aa57f8d5907f5060e634804e66fdd48e`). The previous keys-dfb61aa8 API/worker images remain the code rollback target. The deployed embedding.js SHA-256 is `8485605a4829c700d6889122b2bab61e5203b35945d61cc220f757441081671e`. No database restore or schema change was needed. The pool experiment's overlay had already been restored before this release.

| Simultaneous requests | Fresh baseline p95 | Retained vector lookup p95 |
| --- | --- | --- |
| 10 | 1,311 ms | 1,330 ms |
| 25 | 2,961 ms | 2,737 ms |
| 50 | 5,760 ms | 4,510 ms |
| 100 | Not run | 10,068 ms |

The 50-request threshold is accepted in this short benchmark. The 100-request threshold remains unmet despite zero HTTP errors/degraded sources. A sustained run and broader distinct-account cohort would be separate acceptance work, not conclusions from these two bursts.

Cycle-only evidence: `soundspan/output/coverage-cycle5-final-acceptance.json`; consolidated history: `soundspan/output/coverage-final-acceptance.json`.
