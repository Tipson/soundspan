# Server music sources — acceptance snapshot, 12 September 2026

## Release boundary

**Yandex deployed and enabled; VK disabled pending authorization and acceptance.**
Revision `43bbbfb8` runs in the existing Soundspan backend, worker and frontend.
The owner explicitly approved Yandex OAuth consent;
the resulting account token is stored locally with Windows CurrentUser DPAPI and
restricted filesystem permissions. No token value is included in this report or Git.
The production connection stores the token in the authenticated v2 encryption envelope.
VK browser access was rejected by the browser tool's site-safety policy; manual
token delivery is pending. No alternate browser or extraction workaround was used.
No browser session cookies were extracted.

## Executed checks

- verify: the saved Yandex token decrypted under the owner's Windows user; the
  real `/account/status` API accepted it and reported an active Plus entitlement.
  This confirms account authorization; capacity remains unmeasured.
- verify: isolated Linux / Node 24 backend coverage: 608 suites, 8629 tests passed;
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
  credential-generation constraints passed. The additive migration was then applied
  in production before restarting the backend. No other migration was pending.
- verify: real Yandex full-track acceptance passed for Альянс — На заре,
  Папин Олимпос — Пьяная and Michael Jackson — Billie Jean. Catalog and decoded
  MP3 durations differ by less than 0.1 seconds. Two distant ranges and replay
  matched each complete file byte for byte. Two user leases remained isolated;
  cancellation and provider revocation released their streams and slots.
- verify: an isolated server canary passed backend-direct and frontend-proxy
  full MP3 decoding with FFmpeg (exit 0, no errors), ownership checks and relogin.
  Its unavailable YouTube endpoint caused a same-origin 307 to Yandex in about
  one second, and seeking stayed on that lease. The normal Soundspan player
  played past one minute and sought successfully; browser login survived reload.
- verify: public HTTPS production acceptance repeated all three complete recordings,
  two ranges per recording, relogin and token refresh using a dedicated non-admin
  test account. SHA-256 hashes matched the local and server-canary recordings.
  Existing YouTube playback returned 206 `audio/webm`, 65536 bytes after deployment.
- verify: the owner's existing production session opened the admin page and showed
  Yandex configured/enabled and VK unconfigured. The temporary canary was removed;
  the dedicated production fixture's password login and issued tokens were revoked.
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

Adversarial review: **CLEAN for the verified single-API Yandex release**;
VK activation remains blocked on credentials and real audio acceptance.
Reproduced and corrected:

- a shared ISRC bypassing a clean-version marker;
- diagnostic playback selecting a different provider;
- active streams surviving source revocation;
- an upstream stream closing without an error leaving the HTTP response open;
- malformed Content-Range or truncated bodies being treated as successful audio;
- setting HTTP headers after audio had started, throwing from a stream error handler;
- timeouts without HTTP status failing to enter fallback, and an original attempt
  consuming the frontend's complete time budget;
- an existing recommendation diagnostic logging raw upstream error text.
- hexadecimal Yandex download timestamps being rejected as invalid;
- the 2 MiB metadata limit truncating full audio in the real Axios transport;
- the startup deadline aborting an already acquired audio stream. Its timer is
  cleared after acquisition while listener cancellation remains connected.

Verified guards cover cross-user lease access, credential generation changes,
preview rejection, ambiguous matching, private DNS answers, credential-free CDN
redirects, exact read-only media-cookie paths, connection-slot release and
refusal to splice different representations during seeking.

## Remaining acceptance

1. Obtain the VK token manually in a local file outside Git, then verify its real
   catalog, complete recordings, seeks, repeated and parallel sessions. VK HLS is
   unsupported; an API credential alone does not establish audio availability.
2. Measure the shared account's capacity and test physical mobile devices. The
   eight-stream limit is a code guard, not an accepted user-capacity guarantee.
3. Expand exact-match catalog coverage. Explicit metadata was verified for Пьяная;
   absent or incorrect provider markers cannot establish that a recording is uncensored.
4. Implement other providers from the plan separately. Midstream source switching
   and distributed leases remain unsupported. YouTube CAPTCHA elimination is not proven.

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

The protected release directory is
`/srv/music/soundspan-releases/sources-20260912` on CT121. `backup/manifest.json`
records the Compose inputs and database dump. The custom-format backup contains
28,938,798 bytes; SHA-256 is
`64bab6100bc543d3429843966a1f1a79e5cc818976274d185ef7f53037d69cb3`.
`pg_restore --list` verified the archive TOC; a full database restore was not performed.
`compose.json` selects the deployed images and `rollback.json` the preserved
base images. Include the `worker` Compose profile when operating all three services.
`python3 /srv/music/soundspan-releases/sources-20260912/rollback.py` restores only
the previous application images; verify public authentication and playback afterward.
Runtime artifacts were built and tested in Linux, then layered over the exact
previous production images; existing landing audio and runtime dependencies were preserved.

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
