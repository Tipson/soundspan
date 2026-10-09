# Core user journey regression plan

Goal: run reproducible browser checks for login, taste saving, Wave, daily mixes, real media playback and downloaded playback.

Architecture: extend the existing Playwright test infrastructure with a separate loopback-only config and stateful, per-context API fixtures. Exercise the actual compiled Next application, audio engine, IndexedDB and OPFS with synthetic tracks; never connect to production or consume owner credentials. Block service workers so the request guards see every call; cold offline bootstrap remains a separate acceptance gate. Existing component/backend tests remain complementary API/domain evidence.

Tech Stack: existing Playwright/TypeScript/Node 24, Chromium, compiled frontend. No dependency upgrades or application behavior changes.

Spec: stage three of the owner-approved roadmap. Each scenario must assert an observable outcome rather than page/body presence. Missing data cannot skip a required scenario. Playback requires an advancing browser media clock, not merely a pause icon. Offline assertions disable network and verify a local source. External catalog availability and physical-device behavior remain separate acceptance gates.

Global Constraints: no git push; no production changes; no real credentials/history/tastes; no autopause changes; isolated browser contexts; fixed loopback server and dead loopback upstream; unknown API requests fail closed; synthetic media only; one reused reviewer, implementation inline.

Review Focus: fixtures cannot hide missing calls or wrongly accept unknown writes; authentication and failed save outcomes; actual independent mix queues; paused/resumed/next playback clocks; real offline cache/owner/session isolation and blocked API; CI must fail on required skipped/flaky cases.

- [x] Map existing coverage and write failing browser scenarios for login, taste save/retry, Wave, mixes, playback and offline downloads.
- [x] Add isolated fixtures and a local-only executable config/command, then get the scenarios green without changing product behavior unless a real in-scope regression is demonstrated.
- [x] Wire CI and document the browser/API/provider/device evidence boundary.
- [x] Run browser scenarios, relevant component/unit tests, frontend typecheck/lint/build and review; fix material findings.
- [x] Commit locally and update Obsidian with exact results and remaining roadmap.

Verification: mandatory command passed nine report/media-clock tests and eight browser journeys, zero skips/retries; 109 complementary unit tests, 68 component tests and the existing 50-navigation continuity scenario passed. Full frontend typecheck/build/lint passed (107 existing warnings; changed test files have zero warnings). Ordinary and adversarial review: CLEAN after a regression proved and fixed acceptance of a positive but frozen media clock. CI configuration is committed for owner-triggered execution; GitHub CI and physical phones were not exercised.
