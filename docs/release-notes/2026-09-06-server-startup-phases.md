# Server startup latency investigation

## Execution plan

1. Add bounded timestamps to the actual shared spool path; preserve transport and capacity.
2. Repeat active Wave switching and join browser source IDs to startup timestamps.
3. Correct only the measured bottleneck, with a failing regression test first.
4. Repeat the affected scenario, record cold versus prepared starts separately, and retain rollback.

## Instrumentation

Commit `9c5df66` records milliseconds from shared task creation to resolution start/end, transfer start, first chunk and playable-prefix publication. These are cumulative timestamps, not independent duration fields. Queue before task creation, HTTP response propagation and client decoding are outside this trace. A task may predate the user's click due to preparation. No signed URLs or account IDs are recorded; at most five checkpoints and one publication log per task. No changes to capacities, retries, source quality or deadlines.

verify: 536 tests passed, four skipped on Windows; both modified runtime files passed mypy, Ruff passed and image build passed. Deterministic clock and publication tests cover first-mark retention, detached snapshots and single emission without the signed URL. Self adversarial review found no release blocker in the instrumentation; incomplete coverage of fallback/failure paths is explicit and no overall P0 completion is claimed.

Candidate: `local/soundspan-ytmusic-streamer:timing-9c5df66`; require `YT_STARTUP_TIMING_HEALTHY_9C5DF66` in `output/startup-timing-release.log`. Rollback overlay: `/srv/music/soundspan-releases/b0-b340a7c/compose-before-timing-9c5df66.json`.

## Measured bottleneck and targeted correction

The instrumentation is deployed and healthy. In the initial 21 Wave advances, click-to-playing was 62–5709 ms, with no media errors or 12-second timeouts. Example `5idPf5Irfxk:HIGH`: resolution began at 0 ms, finished at 4276 ms, transfer began at 4303 ms, first chunk/readable at 4939 ms. This does not establish global queue latency or capacity: the trace starts at spool-session creation. The dominant observed work is source resolution and waiting for source bytes, not browser decoding.

Confirmed own-code defect: every new coordinator generation submitted an empty tail, cancelling still-relevant work before adding it back after immediate readiness. The React queue effect also cleared the coordinator while waiting for the network-preload policy. Commit `6498a89ab5b584baa5cedcf055f9bf12aac6897a` preserves the intersection of previously submitted and newly desired work in both paths. Retain-only mode cannot admit new current/immediate/tail IDs, even with a ready lease. Changed quality, removed queue items, constrained tail policy and explicit cleanup still release work. No capacities, concurrent downloads, provider quality or retry counts increased.

verify: original overlap regression failed before implementation and passed afterward. 28 targeted unit tests and 133 player component tests passed; frontend typecheck, scoped lint and immutable-source image build passed. Self adversarial review: CLEAN for the narrow patch; cancellation generations and retention bounds covered. Physical iPhone behavior remains unverified.

## Production acceptance

Additional desktop scenarios: three consecutive Next actions, previous track and pause/resume completed without media errors (`output/tail-behaviors.log`); stopped on pause. The browser's click action overhead spaced the repeated skips farther apart than the requested 150 ms sleeps, so this is not proof of a sub-second burst stress scenario. One unrelated test-avatar HTTP 404 appeared in the console; no media error accompanied it.

Frontend `local/soundspan-frontend:tail-6498a89` deployed with `TAIL_FRONTEND_HEALTHY_6498A89` in `output/tail-retain-release.log`. Backend, worker, YouTube container identities and proxy configuration preserved. Rollback overlay: `/srv/music/soundspan-releases/b0-b340a7c/compose-before-tail-6498a89.json`. No push performed.

21 actual Wave advances after deployment: zero media errors/timeouts, click-to-playing 1181–3235 ms, median 1326 ms (`output/tail-wave-1.log` through `tail-wave-7.log`). These use different tracks/cache conditions from the first run: not a controlled speedup percentage or proof of arbitrary cold-start latency. Browser request capture `output/tail-browser-plans.log` confirms overlapping tail stays present across queue generations instead of being emptied. Server evidence `output/tail-server-timings.log` still contains a 5162 ms source resolution and 6409 ms readable prefix for a prepared job. P0 cold startup is not closed; eliminating wasted cancellation does not eliminate upstream latency. Browser `playing` and advancing media time are not an audible-PCM or physical lock-screen test.
