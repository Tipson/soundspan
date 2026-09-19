# Backend package: 6 September 2026

## Released scope

Source revision: `e5baf93a4b4fef015ff6ed2d4bdd245349ee6ae9`.
API image: `local/soundspan-backend:package-e5baf93`.
Worker image: `local/soundspan-backend-worker:package-e5baf93`.

- Approved YouTube cover origins use the configured outbound proxy. Redirect,
  body-size and timeout checks remain enabled.
- Operator-created test accounts are excluded from recommendation evaluation
  and remote-analysis admission. Existing accounts remain ordinary accounts.
- Analysis selects up to 100 recently active accounts after grouping listening
  records, rather than letting one listener occupy the entire input window.

The frontend, YouTube audio container and Privoxy configuration were unchanged.
No source provider, analysis budget or Hybrid rollout setting was changed.

## Verification

- verify: API and worker immutable image builds exited 0. Existing unchanged
  backend coverage result: 8367 passed, 3 skipped, 584 passing suites.
- verify: deployment environment parser tests: 3 passed; audio-probe budget and
  cancellation checks: 4 passed.
- verify: migration preflight found only
  `20260906060000_isolate_playback_test_accounts`; deployment applied it and both
  replacement services reached healthy state.
- verify: production has 9 ordinary accounts, 0 test accounts and 8 eligible
  active accounts. No existing user's role or listening history was changed.
- verify: previously failing cover origin returned 85112 bytes in 999 ms through
  the released module. Public authenticated cover-art route returned HTTP 200;
  public health returned HTTP 200. All rendered collection images loaded.
- One presence-heartbeat HTTP 503 was observed during API replacement; this was
  not a zero-downtime release. Subsequent health and cover checks succeeded.
- verify: ten concurrent cached audio transfers succeeded and fully decoded;
  first fragments 29–129 ms, complete transfers 270–391 ms on sidecar loopback.
  All ten files existed before the run. This does not establish cold YouTube
  capacity, audible browser latency or support for 100 listeners.

## Recovery

Private database dump:
`/srv/music/soundspan-releases/b0-b340a7c/before-isolation-e5baf93a-attempt-4.dump`.
SHA-256: `51bfec4fa25a62685cc2b88ae1c0d91eae882def90d7fa1bd73f200816e82785`.

Compose snapshot:
`/srv/music/soundspan-releases/b0-b340a7c/compose-before-isolation-e5baf93a-attempt-4.json`.
For a code rollback, restore only backend/worker image references to their
`b0-b340a7c` tags and recreate those two services using the existing complete
compose stack. Retain the additive column and current data; do not restore the
database dump merely to roll back application code. Preserve later unrelated
frontend/audio changes.

## Remaining acceptance

Cold-cache concurrency, rapid Wave skips, real-device background playback and
the broader P6 redesign remain open. The accepted P6 subset is collection scroll
restoration, downloads search, mobile taste-wizard layout and PWA instructions;
native installation and actual phone behavior are not inferred from Chromium.
