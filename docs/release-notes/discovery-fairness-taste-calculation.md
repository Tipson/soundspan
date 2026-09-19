# Discovery fairness and taste calculation

The preparation worker rotates accounts before requesting provider candidates.
Provider failure leaves the account's candidate cursor intact but allows later
accounts to run. Two disjoint, bounded Prisma keyset queries select at most four
eligible accounts, including accounts beyond the former first-hundred bound.
Redis checks cursor writes against the active lease in a single operation.
The fifteen-minute interval, four-account/twelve-candidate bounds, daily budget,
foreground reservation, analysis concurrency and diagnostic history isolation
are unchanged. Budget exhaustion does not advance account turns.

Taste-centroid reuse compares complete raw IEEE-754 input and the requested
centroid count before normalization. It retains the 32-entry/16-Mi-code-unit
bounds, independent returned arrays, and legacy handling of invalid or sparse
vectors. A different input immediately recalculates the result; no account
responses or stale taste profiles are cached.

## Quality interpretation

A whole-queue average can stay constant while the first songs differ: a small
personal pool may include the same twelve tracks in another order. Compare
the first six/twelve tracks, their analysis coverage, and the complete queue.
Do not interpret unknown features as measured intensity or infer subjective
listening quality solely from an arousal score.

The fresh four-account replay found opening-six calm/energetic arousal means
of 0.136/0.793 (dartum), 0.189/0.648 (Attela7), 0.150/0.578
(TochnoRatatyi) and 0.603/0.884 (Pivozavr454). The latter's available
analyzed radio pool contained only one unexposed, non-disliked track below 0.4;
its calm queue remains limited by candidate supply. Ranking weights were
retained. Listening acceptance and changing-catalog coverage remain open.

## Verification

verify: failure-injected integration used actual PostgreSQL/Redis and isolated
cursor keys for thirteen accounts over five cycles/twenty visits. Four initial
provider failures did not prevent later accounts from receiving their turns.
Provider responses were test doubles; queue writes were forbidden and test
keys were removed. Production quota and user history were not changed.

verify: the exact-input calculation benchmark reduced the median from 526 to
139 ms with identical numeric outputs. This is a repeated-input microbenchmark,
not an HTTP latency result. Full release and HTTP evidence follows below.

## Verified rollout: 2026-09-10

verify: revision `2fb4c53b` is deployed as
`local/soundspan-{backend,backend-worker}:mood-2fb4c53b`. Both services became
healthy and the thirteen other containers retained their IDs. The three
deployed module hashes match the local backend build. Frontend is unchanged.

The checked 24,133,840-byte PostgreSQL dump and original Compose overlay are
retained at `/srv/music/soundspan-releases/discovery-mood-2fb4c53b-nkofmkrr/backup`.
Dump SHA-256: `7cc28c91317e8d62f1666a82cdf785bbe2f122b9ae196dad5dee312cfe10eee2`.
Rollback restores the prior API/worker images from that overlay; no schema
migration or database restoration is required for an image rollback.

verify: final backend build, targeted tests and format checks passed. The full
Linux coverage run passed 8,540 tests, skipped seven and failed none across 600
passed suites, with 94.56% line coverage. Final source/test hashes match the
verified container snapshot. Ordinary and adversarial reviews found no
remaining blocker after the sparse-vector regression was corrected.

verify: the paired quality replay evaluated 96 feeds from 48 fixed-input pairs
across four accounts, six contexts and both ranking arms. Track content/order
and degraded-source results matched exactly before/after optimization. The
checked exclusion and diversity invariants had zero violations. The latest
opening-six calm/energetic means were 0.132/0.657, 0.152/0.614,
0.171/0.515 and 0.609/0.832 in the account order above. Source pools vary
between runs, so these figures do not establish a ranking-policy improvement.

verify: the same staged diagnostic HTTP scenario through the frontend proxy
produced the following p95 values (milliseconds):

| Concurrent requests | Before | After | After errors |
| --- | ---: | ---: | ---: |
| 10 | 4,718 | 1,286 | 0 |
| 25 | 3,105 | 2,592 | 0 |
| 50 | 6,127 | 4,817 | 0 |
| 100 | Not run: prior stage exceeded 5 s | 10,819 | 0 |

The 50-request stage passes the 5-second gate; 100 does not. The before run
included a partial YouTube Radio failure, while the after run had no degraded
sources. These are live end-to-end measurements, not a controlled CPU-only
attribution. Both load runs left generation/exposure counts unchanged.

verify: the final four-account frontend-proxy smoke returned 200 without
degraded sources and left generations, exposures and plays unchanged. The
public Windows-host check returned health/API 200 and a 65,536-byte audio/webm
Range response with status 206 in 141 ms. This is a warm audio-path check.
The authenticated backend-direct personalized route also returned 200 with
the diagnostic generation marker and a nonempty feed.

verify: all thirteen real preparation cursors remained unchanged while daily
usage exceeded the foreground-reservation threshold. Budget stayed 750/day,
concurrency two, pending/active/failed queues zero, and synthetic generations
zero. No quota was reset or increased for the validation.
