# Playback test isolation

Production browser and authenticated load tests use dedicated operator-created
accounts. Do not reuse family accounts, their cookies, or their saved queues.
`User.isTestAccount` defaults to `false`; ordinary registration cannot set it.

## Create a fixture

Apply database migrations and deploy the matching backend before running:

```sh
node dist/scripts/createPlaybackTestAccount.js
```

Pipe a private JSON object with `username` and `password` into standard input
(maximum 4 KiB), not command-line arguments. The name must start with `soundspan-test-` and contain lowercase letters,
digits or hyphens. Passwords must contain at least 16 characters and at most 72 UTF-8 bytes. Neither has a default;
credentials are not printed. The command creates a non-admin account and prints
only its ID and username. A collision fails with exit code 1; it never resets a
password, converts an existing account, or copies another user's preferences.
Do not use the legacy `create:testuser` helper for production acceptance tests.

Select taste seeds and playlists explicitly in the fixture account. Keep social
sharing and external scrobbling disconnected. Use a separate browser profile.
Store run outcomes, timing and playback failures in the run's diagnostic report.

## Boundaries

- Listening, likes and recommendation exposures remain scoped to the fixture.
- Hybrid evaluation excludes test users, including its historical comparison
  window, impression counts and participating-account counts. Test rows remain
  available for incident investigation.
- Automatic account hot-set sweeps and foreground hot-set admission exclude test
  users; rapid test playback cannot spend the analysis quota on fixture tastes.
- Audio requests use normal authentication, provider queues, cache and resource
  limits. Test status does not bypass access checks or rate limits.
- Operational request/error counters still observe real test traffic. Label the
  test interval in load reports; those counters are not organic listening data.

Previous tests performed on ordinary accounts cannot be identified reliably by
this flag. Do not delete their history or reclassify real users. Start a clean
evaluation window after isolated testing is enabled.

## Release and rollback

The migration adds a boolean with a false default; it does not rewrite account
identity or delete records. Deploy schema before backend and worker images.
Retain the column during application rollback. Older applications remain
compatible but do not exclude fixtures: stop browser/load tests until the
isolation-aware backend is restored.
