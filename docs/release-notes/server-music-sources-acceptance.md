# Server music sources — acceptance snapshot, 12 September 2026

## Release boundary

**Not deployed or activated.** The implementation is a Yandex/VK prototype in
the existing Soundspan backend. The owner explicitly approved Yandex OAuth consent;
the resulting account token is stored locally with Windows CurrentUser DPAPI and
restricted filesystem permissions. No token value is included in this report or Git.
The token has not been installed in production. VK authorization remains unavailable.
No browser session cookies were extracted.

## Executed checks

- verify: the saved Yandex token decrypted under the owner's Windows user; the
  real `/account/status` API accepted it and reported an active Plus entitlement.
  This confirms account authorization, not full-track playback or platform capacity.
- verify: isolated Linux / Node 24 backend coverage: 608 suites, 8624 tests passed;
  2 suites / 9 tests skipped by their existing environment conditions. PostgreSQL
  advisory-lock tests require a real DATABASE_URL and were not enabled for this run.
- verify: backend TypeScript build and production Next 16.3.1 / Turbopack frontend
  build completed with exit 0 in the isolated Linux source copy.
- verify: frontend component run: 1281 passed, no failures or skips. Shared media
  authentication, preload cache, playback-session URL and proxy timeout run: 61 passed.
- verify: frontend full unit suite: 1624 passed; the existing targeted coverage
  gate passed at 100/100/100 for its three configured files. Those coverage
  percentages do not describe the new source adapters. Frontend lint and complete
  TypeScript check passed.
- verify: repository enforcement gates passed, including the complete formatting
  check. Six targeted YouTube challenge, cooldown and extraction-wait regressions
  passed in an isolated Python 3.13 environment; 127 unrelated tests were deselected.
- verify: Helm chart lint and render assertions passed with Helm 4.0.0 in the
  isolated Linux workspace. No Kubernetes resources were installed or changed.
- verify: migration executed in a separate PostgreSQL 16 container with no network
  and a tmpfs database. Disabled defaults, primary key, provider allowlist and positive
  credential-generation constraints passed. The production database was not migrated.
- verify: production YouTube sidecar returned 206 `audio/webm`, 65536 bytes,
  response headers in 636 ms for `jNQXAC9IVRw`. An earlier cold probe exceeded
  the 8-second first-byte gate. The successful request does not establish a cold
  latency bound or CAPTCHA elimination. An unauthenticated diagnostic 403 was
  discarded as a local authentication failure, not attributed to YouTube.

The initial Windows-wide backend run failed on POSIX path expectations and an
outdated route-mount fixture. The new mount and legacy-route regression were
fixed and tested; the full acceptance run uses Linux. Windows Turbopack cannot
follow the workspace's node_modules junction outside its configured root.

## Review

Ordinary review traced source configuration, encryption inventory, authenticated
media proxying, original stream acquisition, cache keys and recording identity.

Adversarial review: **BLOCK for production activation** until real provider
authorization and audio acceptance are demonstrated. Reproduced and corrected:

- a shared ISRC bypassing a clean-version marker;
- diagnostic playback selecting a different provider;
- active streams surviving source revocation;
- an upstream stream closing without an error leaving the HTTP response open;
- malformed Content-Range or truncated bodies being treated as successful audio;
- setting HTTP headers after audio had started, throwing from a stream error handler;
- timeouts without HTTP status failing to enter fallback, and an original attempt
  consuming the frontend's complete time budget;
- an existing recommendation diagnostic logging raw upstream error text.

Verified guards cover cross-user lease access, credential generation changes,
preview rejection, ambiguous matching, private DNS answers, credential-free CDN
redirects, exact read-only media-cookie paths, connection-slot release and
refusal to splice different representations during seeking.

## Remaining acceptance

1. Transfer the approved Yandex credential from its local protected store into the
   server-only configuration. Obtain the VK credential and confirm the access model
   for the platform. Neither source has passed audio acceptance.
2. On each source, validate full duration and two distant seeks on several selected
   recordings, including uncensored versions. Search success alone is insufficient.
3. Repeat playback under two Soundspan users, cancel one session and revoke the
   provider while streaming. Confirm ownership, independent sessions and recovery.
4. Verify the real browser flow and provider failure on a canary, including reload
   and lease expiry. HLS and midstream source changes remain unsupported.
5. Retain a backup and rollback plan for actual deployment; follow the procedure below.

The aggregate enforcement run passed. Existing formatting drift in the shared
metadata contract, landing assets and two component test files was corrected.
TypeScript/JavaScript syntax trees were compared before and after formatting,
normalizing parentheses, to check preservation of executable structure.
Test-only container-image variables were removed from the production-env scanner's
scope with a regression test; production variables remain checked. Vendored Three.js
is excluded from application ESLint and Prettier rules and was not modified.

No guarantee that anonymous YouTube will never request verification is made.
The existing cooldown/pacing fix remains the production configuration. Lavalink
or another YouTube client does not by itself remove the upstream challenge.

## Deployment and rollback procedure

Before deployment, record current image IDs, Compose inputs and health; back up
PostgreSQL and the protected Compose overlay. Apply the additive migration before
starting backend code that reads MusicSourceConnection. Build images from the
accepted source revision, deploy the single API replica with sources disabled,
and enable only the provider that passes the canary. Frontend and API changes
must ship together for correlated playback attempts and media-cookie auth.

Disable the connection through the admin API to stop its active requests. For
rollback, restore the preceding frontend/backend images and verify playback and
admin access externally. Leave the additive table in place; no destructive schema
rollback is required. A backend restart invalidates in-memory playback leases.
