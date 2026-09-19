# YouTube provider challenge — 11 September 2026

## Incident and reproduction

verify: laurisoul's persisted current track was `yt:2S4g1ITf5k4`, «Пьяная» by Папин Олимпос, stopped at zero. A direct authenticated request to the production sidecar reproduced HTTP 503 after 5.07 seconds with Retry-After 90. A second reported track, `Wwg4JRZrVcs` («По уши в тебя влюблён», Miyagi), received the same cooldown response. The token companion answered its loopback health check; logs recorded a failed recovery attempt and YouTube's verification requirement.

The production extraction spacing was 15–35 milliseconds with 16 extraction workers. This configuration permits aggressive bursts; the incident does not establish that request volume alone caused YouTube's challenge. Short throughput results do not establish sustainable provider quotas.

## Correction and prevention

- Recheck provider cooldown after pacing, including metadata, format retries, anonymous-context fallback and token recovery. Tests reproduced requests escaping the cooldown after a peer failed during their wait.
- Use 90/180/360/720/900-second cooldown windows for repeated refusal. Concurrent failures share a deadline instead of extending it. Fresh extraction success resets older failures without clearing a newer concurrent refusal. Cached audio does not reset the breaker.
- Production `YTMUSIC_EXTRACT_DELAY_MIN=10`, `YTMUSIC_EXTRACT_DELAY_MAX=15`, `YTMUSIC_YTDLP_EXTRACT_CONCURRENCY=2`. Transfer limits, the 8 GiB spool, library mounts and account data remain intact. Cold starts may wait for pacing; complete cached audio requires no provider extraction.

## Verification

- verify: five added behavioral cases were exercised; the regression tests failed before their respective fixes. Full sidecar suite: 650 passed, 4 pre-existing skips. Python 3.13 / yt-dlp 2026.08.19; Ruff lint/format and mypy passed. Runtime image compilation passed.
- verify: production delivered 65,536 bytes of `audio/webm` for «Пьяная» in 1.74 seconds; a repeated request took 0.37 seconds. The second affected track also returned 206 audio in 0.79 seconds. These are bounded HTTP probes, not a load benchmark.
- verify: the public platform browser played «Пьяная» beyond 30 seconds; seeking advanced the timeline to 98 seconds without an error toast. Playback was paused after the check. Full cached file: Opus, 159.241 seconds, 2,561,141 bytes, verified with ffprobe. The physical iPhone from the report was not available for testing.
- verify: 13 neighboring container IDs preserved, all source/target mount mappings and permissions preserved; namespace-sharing companion recreated and healthy; public API health returned 200.
- Adversarial review: CLEAN for this change. Checked concurrent cooldown extension, queued work, fresh-success race, retry bounds, cached availability and rollback. An upstream verification requirement can recur; this release does not guarantee anonymous YouTube availability or prove that the token fallback itself recovered the natural challenge. Recovery was observed after the quieter configuration and service recreation.

## Release and rollback

Image: `local/soundspan-ytmusic:challenge-20260911`.
Active overlay: `/srv/music/soundspan-releases/b0-b340a7c/compose.json`.
Backup: `/srv/music/soundspan-releases/challenge-20260911-v2/compose-before.json`.
Only `ytmusic-streamer` and `ytmusic-pot-provider` were recreated. Restore the protected overlay backup with mode 0600, validate the full Compose invocation from current container labels, recreate the streamer, wait for readiness, force-recreate the companion and verify its network namespace matches the streamer's current ID. Rollback restores the earlier aggressive pacing as well as the image; review those values before choosing it for a future incident.

The initial release automatically rolled back because its mount comparison was order-sensitive. Current Compose and container mount identities were checked; the corrected verification sorts by destination and compares every field. No volume contents were removed or migrated.

