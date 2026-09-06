# P0 playback baseline after the iPhone release

Baseline: production frontend `333b8f6`, YouTube sidecar `9c5df66`.
The user reports that installed iPhone background playback works after this release.
The following checks are separate desktop Chromium production checks, not iOS or
100-listener load acceptance. A dedicated operator test account was used.

## Plan and status

- [x] Reproduce first-start and queue-switch behavior on the deployed release.
- [x] Exercise 20 different tracks across a public playlist and My Wave.
- [x] Exercise rapid selections, return to the previous track, pause and resume.
- [x] Locate the first-start delay using provider timing checkpoints.
- [x] Reject an unsuccessful extraction shortcut without deploying it.
- [ ] Establish a significant, reliable improvement to uncached extraction.
- [ ] Verify that improvement on matching scenarios before closing cold-start P0.

## Measured behavior

| Scenario | Result |
| --- | --- |
| First playlist start, until native position exceeds 0.5 seconds | 4,307 ms |
| Start My Wave, until native `playing` event | 4,251 ms |
| 18 prepared next-track transitions | median 152 ms; range 45–340 ms |
| Six rapid skips, measured from the last selection | final track `playing` at 1,455 ms; position 1.98 seconds two seconds later |
| Previous-track return immediately after rapid selection | approximately 1.3 seconds; most delay before `loadstart` |
| Pause/resume | resumed successfully without another source load |

verify: all 20 principal track selections started, with no selection timeout or
media error observed. The 18 individual next-track samples reached position
1.8 seconds or more before the next selection. This is startup/short-preview
acceptance, not complete-track or long-duration listening acceptance.

The older three-skip helper could accept a `playing` event from an intermediate
selection. Its result is not used as the final rapid-skip timing. The six-skip
check waits for an event after the last selection and checks subsequent progress.

The public playlist was “Лето под звуки классического рока”; the remaining ten
principal selections came from My Wave. No user playlists, likes or taste settings
were edited. Playback was paused at the end.

## Where cold-start time goes

For the first playlist track, `hqqkGxZ1_8I`, the shared server job recorded:

- extraction starts at 0 ms;
- source URL resolved at 2,282 ms;
- transfer starts at 2,319 ms;
- first chunk at 3,199 ms;
- validated playable prefix at 3,200 ms.

These are durations within the server process. Do not subtract browser and server
wall-clock timestamps as if their clocks were synchronized.

An isolated public extraction profile showed a YouTube HTML response of about
1.3 MB, a player API request, and sometimes local player-code processing. The
isolated process does not share the live worker's in-memory preprocessing cache;
its 4,948 ms total is therefore not a substitute for the live 2,282 ms result.

An existing diagnostic's `--skip-page` option failed with `DownloadError`.
The live application's extractor settings were not changed. This is not an
acceptable fast path without a separately proven correctness/fallback design.

Another bounded sample showed a readable prefix after 8 KiB at 800 ms versus
64 KiB at 1,010 ms. That single 210 ms difference is insufficient evidence of a
large cold-start improvement; no global chunk-size change was released.

## Decision

Prepared playback is fast in this sample, and rapid switching did not reproduce
the historical stop/error incident. Uncached startup remains noticeably slower.
P0 cold-start latency is NOT closed. No new runtime change or production release
was made during this baseline pass; the verified iPhone correction is retained.

Evidence: `output/p0-current-start.log`, `p0-current-playlist-{1,2,3}.log`,
`p0-current-wave-start.log`, `p0-current-wave-{1,2,3}.log`,
`p0-current-rapid.log`, `p0-current-behaviors.log`,
`p0-current-server-stages.log`, `p0-current-extraction-profile.log`,
`p0-current-skip-page-profile.log`, `p0-current-prefix-profile.log`.
