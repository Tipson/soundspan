# Android offline physical acceptance — 2026-09-19

Status: FAIL on Pixel; production playback incident remains open.

Production frontend build: `fc392a05-b505-4797-8a61-5af9340f38d0`
(revision `4932b5c7`). No production code or deployment changed in this session.

## Method

Used the installed PWA and existing downloaded tracks. Both devices played in
parallel; Wi-Fi and mobile data were disabled and subsequently restored. Queues
were device-only. Tracks ran naturally without seeking. CDP was disconnected
during observation; ADB collected MediaSession, AudioFlinger and screen state.
Both phones were USB-powered. Audio output was checked through native frame counts
and active tracks, not inferred solely from the MediaSession clock.

Pixel's VPN retained a validated virtual interface and navigator.onLine=true even
without an active default network. That boolean did not establish connectivity.
Subscription-specific mobile_data2 was disabled; the generic mobile_data key was
not authoritative. No VPN settings were changed.

## Results

- Realme RMX2063, Android 11, Chrome 152.0.7977.82: 529.9 seconds in the parallel
  run, five position resets consistent with track handoffs, no sampled frozen
  playback/output. One awake sample; the screen was put back to sleep. Earlier
  setup had intermittent USB disconnections and is not a clean endurance result.
- Pixel 10 Pro, Android 17, Chrome 153.0.8010.36: local playback froze at about
  68 seconds of the track following a natural transition. The MediaSession still
  reported PLAYING, while position and AudioFlinger frame counts stopped and no
  audio output track remained active. An initial muted run retained this mismatch
  for at least 94 seconds. A repeated run at system volume 2/25 reproduced it and
  retained the mismatch for at least 125 seconds. This rules out system muting as
  a sufficient explanation.
- In the repeated Pixel run, Chrome UID 10211 changed from FGS to LAST after the
  handoff. The Chrome browser, audio and renderer processes were all reported
  isFrozen=true when audio stopped. CDP connection timed out while frozen.
- After unlocking, inspection found a local blob source, readyState=4, element
  volume=0.5 and muted=false. The monitor's final pause command means the later
  paused=true observation must not be called an unsolicited native pause.

## Interpretation and limits

Android process freezing is a demonstrated mechanism of this stop. Why Chrome
loses foreground-service status across the handoff is not yet established. The
browser's PLAYING display alone is not evidence of a functioning playback service.
The earlier stale user-action marker fix does not prevent a frozen process.

Some first-pass monitor fields still used the Realme UID and are not evidence
about Pixel network policy or AAudio. The low-volume repeat used the verified
Pixel UID 10211. Its legacy musicMuted field means the volume guard accepted a
muted or very quiet output; native dumpsys separately verified non-muted 2/25.

An in-page experiment updated navigator.mediaSession.playbackState directly from
native play/playing/pause/ended events, following the general pattern in Kima and
Google's Media Session sample. It did not prevent the freeze and was rejected.
The experiment was removed by reloading the page and checking the probe absent.
Do not deploy this experiment as a fix.

Reference: https://googlechrome.github.io/samples/media-session/audio.html

Next investigation: trace Chrome's playback foreground service/audio focus at the
source boundary; validate any change on the same Pixel with offline natural
handoffs for longer than the observed freeze window. Avoid another timer-only
recovery patch: page timers cannot execute while the process is frozen.

## Artifacts and cleanup

Private raw evidence and a sanitized summary remain outside Git under the sibling
soundspan/diagnostics/playback-20260919 directory. Relevant files include
physical-summary.json, pixel-low-volume.jsonl, pixel-low-volume-processes-private.txt,
pixel-elements.json and realme-parallel.jsonl. Do not publish raw process dumps or
owner-scoped diagnostic records. Wi-Fi and mobile data were restored on both
phones; playback was paused. Pixel was returned to mute. No app data was cleared.
