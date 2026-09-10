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
