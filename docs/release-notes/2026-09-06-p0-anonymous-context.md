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

Residual risks: upstream can reject anonymous playback independently of this optimization. Physical-device audibility and 100 concurrent external listeners are not established by these tests. Production user-flow acceptance must follow deployment.

## First-context initialization

The empty/expired-context path requests public music configuration with a scoped 1.5-second socket timeout. One initializer is admitted at a time; failure/rejection prevents immediate repeated initialization for one minute. The original extraction path remains available. No account credentials or user-specific catalog state are read.

verify: same cold Gimme Shelter resolution: ordinary 2540 ms, initialized candidate 1664 ms, identical Opus 251 / 132.001 kbps. This includes initialization, not CDN transfer. Full sidecar suite after initialization changes: 553 passed, 4 skipped. Ruff, formatting and targeted mypy passed. Tests cover initialization failure/backoff and owned-session cleanup.

## Paced queue priority

The previous limiter held its lock while sleeping for the next slot. A preload could therefore occupy that slot before a newly selected track. The extraction limiter uses priority/FIFO selection at admission while preserving the configured inter-request gap (production 0.75–2.5 seconds). Waiting work observes cancellation and an extraction-timeout bound; cancelled waiters do not consume a slot. Session priority is bound to and restored on the resolver thread.

verify: deterministic gate test admits playback before a previously waiting preload at time 10 and the preload at time 20, preserving the ten-second test interval. Cancellation/deadline and thread-context restoration tests passed. Full sidecar suite: 558 passed, 4 skipped; Ruff/format and targeted mypy passed. Self-review retained the same provider rate and bounded pools; real-world load capacity remains separate from this queue correction.

## Release procedure

Deploy only the YouTube sidecar. Keep the previous image and compose overlay backup for rollback. Do not change DNS, credentials, concurrency or the frontend. Record the actual release image and production checks below after execution.

## Track-specific fallback isolation

Missing or combined audio on one recording uses ordinary extraction without rejecting anonymous context for other recordings. Only a bot challenge invalidates the shared context. Regression tests failed for both format cases before this correction and pass afterward; challenge backoff remains covered.

verify: full suite 558 passed, 4 skipped; targeted Ruff/format and mypy passed. Self-review: fallback preserves the original audio selector and paced request budget; no credentials, concurrency or retry-count changes. This fixes a confirmed shared-state defect, but does not by itself establish the cause of every slow upstream response.

## Production acceptance of priority-f4dbd2b

verify: deployed and healthy. Nine playlist selections and thirteen Wave tracks reached playback without media errors or timeout. Playlist starts ranged 443–3662 ms; nine prepared Wave transitions ranged 44–183 ms. Six rapid skips exposed a remaining 7590 ms start on Demons, including 5072 ms source resolution and roughly 1250 ms client coalescing. P0 is not closed. An isolated fresh-context lookup of the same recording took 1679 ms plus 1074 ms to a readable CDN prefix; this is not an equivalent rapid-switch acceptance run.
