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
- Release and post-release acceptance are recorded below when completed.

## Quality boundaries

At the initial snapshot, 2,770 live canonical recordings had completed scalar analysis and 2,768 had completed embeddings. Of the completed scalar rows, 666 used the central-fragment model version and 2,104 retained the older version. The snapshot is not a fixed user cohort, and older versions are not automatically incorrect.

Observed Wave outcomes after the prior release did not include comparable served baseline and Hybrid sessions within the same account. Hybrid remains at 50%; neither expansion nor removal is supported by these observations. Subjective quality still needs ordinary listening, which diagnostic requests must not fabricate.
