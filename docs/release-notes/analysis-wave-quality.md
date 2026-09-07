# P4/P5 analysis and Wave quality

Status: implementation; baseline 8ece0883, production not changed by this package.

## Acceptance sequence

1. Capture read-only production analysis counters and organic recommendation evaluation.
2. Reproduce analysis admission starvation and incomplete skip telemetry in behavioral tests.
3. Fix the confirmed causes without increasing provider concurrency or changing rollout allocation.
4. Verify targeted tests, PostgreSQL admission behavior, build and backend regression tests; one risk-focused review.
5. Release the checked backend/worker package with rollback and verify runtime; report remaining observation gates honestly.

## Before (2026-09-07 09:25 UTC)

- Live canonical recordings: 4,705. Scalar analysis: 1,545; active-space embeddings: 1,548. Last24h: 239 / 234 completed.
- Diagnostic priority slice: likes or last7-day plays from accounts active in90days (11 accounts); 1,330 recordings, 1,053 scalar / 1,055 embeddings. This is an explicit diagnostic slice, not the complete scheduler hot set.
- Remote analysis: enabled, budget250/day, concurrency2. Redis reservation attempts279 today (includes denials, not completed work). No active assets at snapshot; latest scalar completion07:25 UTC.
- Last24h leases: 242completed,16expired,1failed. Expired rows are not automatically16 distinct playback failures.
- Hybrid: active25%, exploration10%. Seven-day report: 10participating accounts, only3 within-account comparisons. Test-account flag excludes the dedicated fixture; older ordinary-account tests cannot be identified automatically.
- Read-only evaluator initially failed to bootstrap DATABASE_URL; preloading config produced the report. This was an operator CLI defect, not production database unavailability.

## Decision

Do not increase analysis concurrency or Hybrid allocation from this small observational sample. Avoid interpreting mixed shadow/served repeat rates as a causal user-quality improvement. Acceptance requires actual analysis work and correct response to known versus missing skip evidence, not merely green counters.

## Implemented and verified

- Admission filters in-flight and24h-cooldown recordings **before** the16-recording analysis limit. The same predicate still guards final admission; Bull retries retain their existing cooldown exemption. Identity enrichment retains its separate4-recording lane.
- A PostgreSQL fixture with16blocked and2ready liked recordings returned only blocked rows before the fix; afterwards it returns the2ready rows. Failed scalar/embedding records re-enter after cooldown; expired leases do not permanently exclude work. Selection itself creates no leases.
- One shared early-skip rule for taste and evaluation uses known measurements, not null-as-zero. Measured early skips still demote similar sound. Neutral/failure rows do not inflate session taste signal counts.
- Nine behavioral cases exercise incomplete telemetry, measured skips, failed playback, ranking and evaluation. Full Linux coverage gate:586passed suites,8380passed tests,1suite/5tests existing skips; lines94.46%, branches83.21%. Separate PostgreSQL suites:6/6passed. Windows-only full run had115failures in27path/permissions-oriented suites; Linux verification used the unchanged tests and non-root runtime.
- Production Linux image TypeScript build passed. No database migration, budget increase, provider-concurrency change or Hybrid-rollout expansion.
- The operator evaluation CLI loads split POSTGRES_* configuration before Prisma; the pre-fix production command reproduced P1001 at127.0.0.1, while config preloading produced a valid report.

## Organic evidence, not change-attributed uplift

Served-only seven-day snapshot (09:42UTC): baseline520generations/1987viewed exposures, Hybrid91/619. One-day repeats53.5%/15.8%; seven-day58.9%/27.0%. These are observed cohorts with different sizes and composition, **not a causal improvement from this package**. Only3within-account comparisons remain.

Missing-measurement skipped exposures in this production window:0. The taste fix closes a reproducible edge case; it does not explain current organic playback failures or demonstrate a measured production uplift.

## Adversarial review

Scope: selection-before-limit, retry/cooldown boundaries, null evidence, account isolation and release rollback. Verdict:CLEAN for the scoped corrections. No new writes in selection, no enlarged query result limits, no schema change, no fixture taste admitted to organic analysis/evaluation. Existing cooldown and in-flight gates preserved and PostgreSQL-tested.

Residual: daily budget exhaustion and continuous catalog growth are operational limits, not fixed by this package. Three accounts cannot justify a broad recommendation-quality claim. Device playback/P0 is outside this release.
