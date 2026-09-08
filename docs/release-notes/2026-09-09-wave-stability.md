# Wave delivery and analysis reuse — 2026-09-09

Baseline: `dea87114`. This package does not claim prior Wave ranking changes as new work.

## Scope

- Batch existing canonical mappings with a 250-candidate / 1,000-row bound. Ambiguous, stale, broken-alias and lookup-error cases fall back to individual resolution. There is no shared identity cache, schema migration or taste-history mutation.
- Reuse a validated CDN redirect for subsequent ranges within one download. Allow same-origin URLs or HTTPS Googlevideo CDN hops, rejecting credentials, nonstandard ports and byte-specific query ranges. Preserve length, offset, entity-validator and cancellation checks.
- Reuse a completed HIGH spool for MEDIUM analysis requests, using the existing pin/eviction contract. Playback/preload quality contracts and partial-file exclusion remain unchanged.
- Preserve the selected Wave lane policy on every continuation: Discoveries uses discovery tracks, Familiar uses familiar tracks, For You uses the same interleaving as the first page. Late responses remain fenced by the active playback context.
- Allow up to 30 seconds for the startup-only FFmpeg version probe. Host backup I/O reproduced a 12-second executable startup and a five-second application startup crash. Unsupported versions and probes with no valid output still fail; playback deadlines are unchanged.

## Verification before release

- verify: Linux backend coverage after the startup fix: 595 suites, 8,472 tests passed; 7 skipped, zero failures. Backend build passed.
- verify: 95 targeted backend tests and a real PostgreSQL migration/integration scenario passed.
- verify: YouTube streamer: 603 tests passed, 4 skipped. Redirect tests use a real local HTTP redirect server; analysis tests cover pinning, complete files, quality and request purpose.
- verify: frozen production inputs preserve the complete ordered result. Dartum: 102 individual mapping resolutions to zero; warm measured stage 411 ms to 181–320 ms. Laurisoul: 51 to zero; 136–143 ms to 90–92 ms. These timings isolate the changed stage, not full HTTP latency.
- verify: real Chrome playback diagnostics: 28 actions, 24 distinct tracks, Wave and Liked Songs, including Back. Zero media errors or observed clock stalls, p95 1,455 ms, maximum 1,615 ms. This is not 24 complete listens or physical audio verification.
- verify: 35 targeted frontend tests passed, including continuation modes and stale responses. Full frontend typecheck and the webpack production build passed. A stale language-retune test was aligned with the already-retired language filter, preserving the direction/mood assertions.

## CDN routing correction

The Soundspan-specific Privoxy rule forced all Googlevideo hosts through SOCKS4/local DNS. Identical full files showed repeated CDN redirects, 1,747–7,792 ms completion and a reproduced read timeout. A SOCKS5 canary completed six files four times each in 446–844 ms with matching checksums and no errors.

The production rule was narrowed to the individually verified IPv6-broken host `rr3---sn-4g5ednkl.googlevideo.com`. Other hosts use the existing SOCKS5t route. The tunnel, source IP, listener ACL, TLS and neighboring services are unchanged. Privoxy reloaded the validated file without a PID change.

verify: the same two files, four passes each through the actual production route: 676–754 ms complete, 244–320 ms first byte, no redirects or checksum differences. The retained exception answers through IPv4.

Routing rollback: `/srv/music/soundspan-releases/wave-cdn-redirect-5ii3xpy6/privoxy-before.config`. Runtime images have a separate compose-overlay backup and health-checked rollback.

## Acceptance boundaries

No natural YouTube CAPTCHA occurred during these measurements. Neither PO tokens nor CDN routing constitute proof of CAPTCHA recovery. Cold metadata extraction, simultaneous distinct cold downloads and sustained user-perceived playback must be reported separately from cache throughput. Hybrid observational outcomes are not randomized causal evidence.

Post-release acceptance is recorded with the actual image revision and fresh measurements, not inferred from a successful build.
