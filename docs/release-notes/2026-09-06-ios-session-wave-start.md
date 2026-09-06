# iPhone audio session and Wave startup preparation

## Scope

- `ecf42c1`: configure the native media element's supported Audio Session API as `playback` immediately before every play, including a new source and resume. Unsupported or throwing implementations do not prevent playback. The WebAudio PWA bridge remains disabled.
- `a3f19e6`: prepare one visible Wave startup source after a 300 ms dwell using the existing authenticated, user-scoped tail-warmup endpoint. Do not play audio or create listening feedback. Skip Save Data and 2G; cancel on hidden/unmount unless Play has handed the resource to foreground playback.
- Server limits remain one background worker, four queued positions and a bounded owner TTL. Foreground submission does not wait for this speculative request. No automatic retries added.

## Verification

- verify: iOS regression tests failed before the session configuration; 127 native engine/policy tests and four Media Session tests passed after it; typecheck, lint and production image build passed.
- verify: desktop production playback and Pause/Play progressed after `ecf42c1`. Chromium has no Audio Session API, so this is regression coverage, not iPhone lock-screen acceptance.
- verify: three Wave warmup tests, one component lifecycle test, full frontend typecheck and image build passed. ESLint reports zero errors and one pre-existing `setPendingRetune` effect warning outside the changed logic.
- Warmup behavior is tested separately from genuinely cold lookup. The previous measured cold browser start remains 4319 ms; prepared starts do not replace that measurement.

## Bounded self adversarial review

Verdict: CONCERNS for overall task closure; no confirmed release-blocking defect in these narrow changes.

- Checked cancellation generations, idempotent disposal, retained interest on Play, rejected requests without retries, data saving and hidden-page cleanup.
- Backend authenticates and prefixes owner IDs with user identity and resolves the user's audio quality. Existing server queue and TTL bound speculative work; no new provider concurrency.
- The iPhone API operation is synchronous, capability guarded and best effort; it does not introduce an AudioContext or a second playing media element.
- Residual: physical locked iPhone handoff and lock-screen Pause/Play still require a real-device check. Desktop media events do not prove audible output. An arbitrary uncached source remains dependent on provider lookup; P0 is not closed by prewarming alone. No 100-listener capacity claim.

## Release / rollback

- iOS candidate deployed as `local/soundspan-frontend:ios-ecf42c1`; health verified. Rollback overlay: `/srv/music/soundspan-releases/b0-b340a7c/compose-before-ios-ecf42c1.json`.
- Wave candidate: `local/soundspan-frontend:wave-a3f19e6`; release evidence is `output/wave-release.log`. Before declaring deployed, require `WAVE_FRONTEND_HEALTHY_A3F19E6` and a browser smoke check.
- verify: the release marker was observed, followed by an authenticated browser warmup request for one startup source, HTTP 200. Click-to-`playing` was 402 ms with subsequent playback progress (`output/wave-browser-preparation.log`, `output/wave-browser-start.log`). This is a prepared start, not a matched cold before/after comparison.
- verify: 21 Wave Next actions completed without the 12 s test deadline. Twenty actions reached `playing` within 52–411 ms. One action hit media error 4 on `wjZMcWaniA4`, skipped it and reached the following song in 1459 ms. **Acceptance is not clean.** The same source returned a correct 128-byte WebM range (HTTP 206) and then played for 1.25 s in an isolated Audio element. That repeat does not establish the original cause or a fix. Evidence: `output/wave-skips-{1..7}.log`, `output/wave-error-prefix.log`, `output/wave-error-decode.log`.
- verify: desktop Pause/Play progressed. A rapid double Previous did not have active media within the short 1 s observation; after explicit Play it progressed without a media error. Do not present this as a clean uninterrupted back-navigation acceptance (`output/wave-resume-back.log`, `output/wave-back-completion.log`). Test playback stopped afterward.
- Wave rollback overlay: `/srv/music/soundspan-releases/b0-b340a7c/compose-before-wave-a3f19e6.json`; restores the iOS-only frontend. Release helper changes frontend only and checks all other service identities and proxy hash remain unchanged. No git push.

## Follow-up: failed Wave source was an internal HTTP 500

- Browser request 2455 at 13:46:24 UTC returned HTTP 500 with `Failed to stream audio`, not WebM. Backend logged `socket hang up`. Thus media error 4 did not establish a damaged recording or decoder defect. Production logs did not preserve the `reusedSocket` flag, so that exact transport condition remains an inference.
- `b32691e` handles the documented Node keep-alive race: retry a GET once only for `ECONNRESET` on a reused socket before a response. Use a fresh connection, unchanged Range/quality and the same admission lease, abort signal and deadline. No retry for fresh-socket failure or HTTP responses; a second reset escapes normally.
- verify: a real local HTTP server resets its reused connection before headers. The test failed with the same socket-hang-up stack before the change and returned the original requested bytes afterward. Also tested a failed recovery (only three total requests including warmup) and fresh-socket reset (one request). All 52 related service/transport tests, backend typecheck and build passed. Source changes from deployed e5baf93 are limited to this service and its new test.
- Bounded self-review: no response body is replayed, no extra concurrent admission is granted and no retry loop or timeout extension is introduced. Original production reuse classification and physical iPhone behavior remain unverified.
- Candidate API image `local/soundspan-backend:socket-b32691e`; require `SOCKET_BACKEND_HEALTHY_B32691E` in `output/socket-release.log`. Rollback overlay `/srv/music/soundspan-releases/b0-b340a7c/compose-before-socket-b32691e.json`; frontend, worker, YT and proxy are preserved.
- verify: marker observed and production repeated 21 Wave Next actions after release, with 900 ms previews. Zero media errors and zero 12 s deadlines, but measured starts ranged 151–5999 ms. The slowest `PllNSSUz3gk` spent approximately 5.65 s between `loadstart` and `loadedmetadata`, then 15 ms to `playing`; its completed spool is WebM, so no evidence for an end-of-file MP4 metadata explanation. This is **not** a clean cold-latency acceptance. Logs do not resolve that interval into provider lookup, transfer admission and first-byte timing. Evidence: `output/wave-after-socket-{1..7}.log`. Playback paused afterward.
