# Source recovery and taste settings

## Scope

This release covers the four approved priorities: alternate-source failure handling, incomplete taste-seed recovery, worker listener warnings, and artist-first taste settings. It does not change the native/offline audio transport, downloaded files, listening history, device synchronization or radio recommendation algorithms.

## Failure boundaries

- Initial YouTube 404, 429, 500, 502, 503, 504 and classified connection failures can resolve through configured server sources. Explicit 400, 401, 403 and 451 responses retain their original restriction. There is no CAPTCHA, age-verification or entitlement bypass.
- A UUID playback session pins one audio representation. A later seek cannot splice another codec or recording into an acquired stream. Speculative preload does not launch another provider search. The primary startup budget is 60 seconds and alternate resolution is bounded by its existing 16-second budget.
- Matching requires compatible artist, title, duration and version markers. Ambiguous, preview and clean replacements do not silently replace the requested recording. A late alternate response after cancellation cannot pin a stale redirect.
- Taste choices survive partial or complete provider search failure. Only unresolved queries are retried on eligible profile reads, at least a minute apart and at most three attempts in total. Concurrent reads in one API process share recovery; the persisted compare-and-set prevents it overwriting a later save or skip. A user can explicitly resave to retry after exhaustion. Recovery needs an open/reopened application; it is not an offline background task.
- Bull scheduler processor registration waits for both actual Redis clients, with timeout and listener cleanup. Named handlers, concurrency and job routing remain intact; global listener limits are unchanged.

## Verification and review

Behavioral checks cover temporary and explicit source errors, cancellation, recording/version guards, total/partial taste outages, service recreation, retry exhaustion, concurrent reads, newer edits and skips. Component checks cover direct artist selection, filters, canonical search and keyboard selection, failure/reopen, duplicate save protection, focus and Escape, progressive artwork with at most three concurrent requests, and cancellation on close.

Ordinary and adversarial review inspected persistence/API/UI contracts, cancellation, bounded fan-out, backward data compatibility and release/rollback scope. No P0/P1 findings remain in the reviewed changes. Provider and production evidence is recorded separately from deterministic simulations in the deployment report and the canonical Obsidian backlog. Successful probes are samples, not a guarantee of continuous external-provider availability.

Portraits use existing Soundspan artist discovery and image proxy services. Missing images retain labelled initials and never block selection. Existing saved genres remain editable; genre pills filter the artist catalog and do not implicitly modify preferences. Taste selection does not add likes or listening history.
