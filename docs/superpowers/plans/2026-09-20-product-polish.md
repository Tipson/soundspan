# Product polish implementation plan

Goal: deliver the approved tasks rated <=3/5, then validate production and update the Obsidian backlog.

Spec: user-approved scope is radio/track radio, ordered queue from a clicked row (remaining rows, including pagination, offline downloaded-only), removal of redundant collection playback panels and the New and Notable shelf, and a complete artist/genre taste setup inspired by Yandex in our design. Preserve collection actions and shuffle separately. Cross-device Connect, new personal mixes, whole-app audit, and full provider fallback investigation are deferred.

Architecture: keep the existing audio engine and API boundary; fix queue/radio producers and existing taste editor. No new dependencies or database schema changes unless a demonstrated requirement forces reconsideration.

- [x] Diagnose radio and track-radio flows; behavioral RED/GREEN tests; repair missing/empty provider cases without pretending a station started.
- [x] Audit collection click handlers and pagination; tests for first/fifth row, current ordering, downloaded-only; remove redundant playback UI while retaining collection actions.
- [x] Improve taste editor using existing persistence and recommendation consumers; test search/selection/save/reopen and mobile behavior.
- [x] Remove New and Notable from home without replacing it with filler; update home tests.
- [x] Record current and future tasks in the existing Obsidian project area.
- [x] Review each change, then adversarial review queue/concurrency/API behavior; run builds and appropriate complete verification gates.
- [x] Release with backup and rollback, preserve runtime configuration, verify browser flows and public production endpoints; record verified limits.

Constraints: Russian UI; owner-only git push; no fake listening history; no secret-bearing evidence; do not clear downloaded data; no forced audio playback on the user's existing session. Worktree: soundspan-playback-index, base 935c399f. Production release is explicitly authorized.

Review focus: list order/filter/pagination; offline missing files; radio end-of-queue; taste save failures and keyboard/mobile use; unchanged playback recovery and source settings.

Implementation evidence: home 7 targeted tests, taste 26, queue 60 (follow-up guards 26 and toolbar 25), radio 48 after request-intent race fix. Task reviews passed. The adaptive Wave refresh versus new-radio race was corrected; final adversarial review is CLEAN. verify: backend build and full coverage passed (619 suites, 8,766 tests). WSL suffered repeated system-level E_UNEXPECTED interruptions; full validation moved to an isolated Linux container with bounded CPU and memory and no production network or credentials. The final backend run used 4 CPUs and two test workers; frontend verification uses 2 CPUs.

Radio scope: local and YouTube recording seeds, remote-only liked and playlist queues. Unsupported provider seeds produce explicit feedback. Continuing radio uses the existing Wave path; dedicated cross-provider seed-preserving radio is future work, not a claim of this release.

verify: frontend production build, 1,743 unit tests, 1,397 component tests, strict targeted coverage, complete typecheck, lint and enforcement gates passed. Historical TIDAL artist-radio navigation is preserved; full component verification caught and covered this regression.

verify: production release a03496a7 completed with a verified 47,790,358-byte PostgreSQL backup and image/config rollback. Three services healthy, zero restarts, 12 neighbors preserved. Public radio returned 11 distinct YouTube tracks in 1,332 ms; invalid seed rejected; audio Range 206; test-account taste save/readback passed. Desktop/mobile-width browser acceptance passed; physical-phone playback was not retested. Obsidian Music-Server note 34 records current and future tasks.

Production limitation: taste-profile persistence passed, but four provider seed searches returned HTTP 503 warnings and the resulting profile has two seeds. Partial seed recovery remains with deferred provider-resilience work; do not interpret save/readback as complete provider availability. The existing worker Redis XGROUP startup warning persists.
