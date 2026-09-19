# Playback interruption investigation, 2026-09-19

## Evidence and scope

The production incident journal contains background native pauses with play intent
still enabled and ready audio in the buffer. On September 18 it includes two iOS
device-file occurrences with approximately 48 and 39 seconds buffered. On September
19 at 13:24 Moscow time, an iOS network track paused with approximately 100 seconds
buffered; recovery was scheduled in the background but completed after the document
became visible. At 13:32 a track stalled near 0.3 seconds with approximately 190
seconds buffered. These observations establish audio-pipeline or lifecycle symptoms,
not a YouTube CAPTCHA explanation. The triggering OS action is not recorded.

Android downloaded-playback interruptions are user-reported. The inspected recent
journal does not establish an Android-specific cause; the shared player defect
below applies irrespective of OS and source. Do not interpret every engine pause
as a defect: headphones, competing media, and explicit controls can also pause audio.

## Original implementations

- Soundspan upstream, `fe95f202`, retains the same unconditional
  `isUserInitiatedRef.current = true` in `usePlaybackControlSync`. Its native engine
  policy ignores `PLAY_REQUESTED` while already playing. Its orchestrator ignores
  recovery for a pause marked user-initiated. Thus the defect is inherited, rather
  than evidence that wholesale rollback to upstream fixes it.
- Kima, `047e472`, separates `intent` and `pauseClass` in `audio-engine-policy.ts`.
  An external `native-pause` retains intent and sets `resumeOnForeground`; its
  controller uses a separate `expectingPause` flag for its own pause command.
  This avoids treating every synchronization effect as an explicit user action,
  but foreground resume is not proof of uninterrupted background playback.

References:
[Soundspan control sync](https://github.com/soundspan/soundspan/blob/fe95f202/frontend/components/player/hooks/usePlaybackControlSync.ts),
[Kima policy](https://github.com/Chevron7Locked/kima-hub/blob/047e472/frontend/lib/audio-engine-policy.ts).

## Reproduced defect and correction

1. Start a track and confirm progress.
2. Rerun playback control synchronization while the engine is playing, for example
   by changing repeat mode.
3. Native `play()` is a no-op, so no subsequent play event clears the user marker.
4. After startup timers have retired, emit an external background pause with a
   populated buffer.
5. The stale marker suppresses the pause recovery handler.

The regression test failed with zero recovery reloads instead of one before the
correction. Synchronizing an already playing engine clears the stale action marker;
commands that actually start or pause playback retain their existing classification.
The correction does not increase retry budgets or replace a downloaded source.

## Remaining acceptance boundary

The test proves one missing recovery path, not the origin of every OS interruption.
Timer suspension, platform audio focus and buffered decoder stalls require physical
device acceptance. A healthy server or advancing media clock alone cannot prove
audible output. Keep explicit pause, source replacement and follower-session guards.

## Validation

- Regression reproduced before the fix (zero recovery reloads instead of one),
  then passed with the correction.
- Component suite: 1375 passed; unit suite: 1702 passed; strict native coverage
  suite: 34 passed, 100/100/100 for its configured targets.
- Typecheck and production build passed. ESLint: zero errors, 105 warnings.
- Adversarial review: CLEAN for this narrow change. Explicit pause remains marked
  user-initiated; existing pause-intent, load-generation, seek and follower fences
  are unchanged and covered by the passing suite. No new logging or retry budget.
- No prolonged physical Android/iOS acceptance was performed for this release.

## Production verification

Released frontend revision `4932b5c7` on September 19, 2026 at approximately
15:32 Moscow time. Only the frontend container changed; backend and providers kept
their container IDs. Public `/health` returned HTTP 200 and the frontend was healthy.
Published service-worker build: `fc392a05-b505-4797-8a61-5af9340f38d0`.

An isolated muted Chromium run against the published frontend recovered an induced
pause while document visibility was overridden to hidden. Three local fixture
tracks completed with automatic handoffs of approximately 30 and 31 ms. Every
playing source was a local blob, the queue remained device-only, and no provider
resolve/stream request occurred. APIs were stubbed in the test context to avoid
creating listening history. This tests browser behavior, not real OS suspension.

Release/rollback files are in `/srv/music/soundspan-releases/pause-marker-20260919`.
Previous frontend image remains available:
`sha256:3ec6f6498203b2fed755d77af2ca1d7e2cdbe3201074ce7ea4a7bfa0acedd61f`.
Current frontend image:
`sha256:46a3fe3ec00add5cfaf9836979667726227745b7ee62497d26227b35ce8f861e`.
