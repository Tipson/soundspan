# P0 anonymous context and early audio prefix

## Scope

- Reuse one anonymous visitor context for ten minutes, bounded to 4096 characters; never persist or log it.
- HIGH resolution accepts only direct Opus format 251 from the accelerated path. Other output uses the original format selector.
- Rejected context is invalidated with compare-and-remove and a one-minute shortcut backoff. Ordinary extraction remains the fallback; transport failures do not add a retry.
- Account cookies/credentials and untested yt-dlp versions bypass the shortcut. Extractor replacement is instance-local.
- Initial CDN reads use 8 KiB, subsequent ranges use 64 KiB. Range validation, cancellation, transfer ownership and audio bytes are unchanged.
- No frontend changes; the verified iPhone release remains intact.

## Evidence before release

verify: same-track source resolution: ordinary 2694 ms, contextual 969 ms; same Opus 251 at 125.165 kbps. Separate implementation check: 2338 ms ordinary, 1260 ms contextual on the same track; two other contextual resolutions 1208/883 ms. Real CDN prefix requests returned 206 and readable audio. These are source-stage measurements, not click-to-sound or load acceptance.

verify: gated real HTTP test failed before early-prefix change and passed afterward. Full sidecar suite: 547 passed, 4 skipped. Ruff and targeted strict mypy passed. One prior full run hit the existing 50 ms library-registry deadline test; its isolated suite and the subsequent full run passed without changing that test.

## Self adversarial review

Verdict: CONCERNS, no blocking finding in the tested boundary. Tested expiry, stale invalidation, rejection fallback, unchanged options, wrong/combined format fallback, no transport retry, anonymous/account isolation, unknown-version bypass, transfer closure and byte continuity. No agents used.

Residual risks: upstream can reject anonymous playback independently of this optimization; the first extraction after expiry still uses the ordinary path. Physical-device audibility and 100 concurrent external listeners are not established by these tests. Production user-flow acceptance must follow deployment.

## Release

Deploy only the YouTube sidecar. Keep the previous image and compose overlay backup for rollback. Do not change DNS, credentials, concurrency or the frontend. Record the actual release image and production checks below after execution.
