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

## Foreground-service comparison

An isolated native player using generated local WAV files also lost Chrome's
foreground service when advancing after native `ended`. A separate prototype
kept the element looping, detected the natural timeline wrap and synchronously
assigned and played the next source. In its three-minute run the second source
reached 148.5 seconds with foreground service and active native output retained.
This is an isolated experiment, not a production correction.

Applying only loop-wrap end dispatch to Soundspan did not establish a fix.
The offline, Home-screen run recorded 37 samples over 416 seconds with CDP
disconnected. At the track change Chrome changed from FGS to LAST. The next
track stopped at 69.190 seconds; nine successive samples showed that same
position and zero active output tracks, spanning 92.2 seconds. The screen was
awake, so this reproduction does not depend on screen locking. Raw evidence:
`pixel-real-loop-player.jsonl` in the private diagnostic directory.

One remaining difference is that the isolated prototype invokes `play()`
synchronously after assigning `src`, while Soundspan's native engine waits for
`loadedmetadata`. That difference is a hypothesis, not a demonstrated cause.
The next comparative launch was denied by the execution approval layer with
`blocked by policy`; it did not run. Loop-wrap event details were not retrieved,
so this run cannot distinguish the injected end handler from another existing
end-detection path. No runtime code was changed or deployed.

The monitor restored Wi-Fi/mobile data and sent media pause. A subsequent
cleanup reloaded the page to discard the temporary in-page prototype. Pixel's
original `stay_on_while_plugged_in=15` setting was restored. The 30-minute
screen-off acceptance and a verified production correction remain outstanding.

## Continuous stream comparison

Subsequent real-app experiments also failed: an immediate `play()` request after
source assignment stopped at 68.127 seconds; loop/seeking detection plus an early
play request stopped at 69.166 seconds; forcing the Howler engine stopped at
68.160 seconds. A single loop/early-play success was not repeatable and its
in-page event history was lost during foregrounding. These are rejected fixes.

After the user foregrounded the isolated test in Chrome, the MediaSource
prototype ran for 32 minutes with Wi-Fi and mobile data disabled. The 166 native
samples span 1,914.69 seconds: all retained Chrome FGS, active output, and changing
AudioFlinger frame counts. Nine metadata identities and all nine visited recording
indices were confirmed. Two samples were awake; the remaining 164 were dozing or
asleep. This is not a fully uninterrupted screen-off acceptance run. Final page
inspection reported position 1,946.30 seconds and no fixture or native media
errors. Monitoring paused playback and restored connectivity after the run.

The result proves isolated continuous-stream viability on this Pixel, not a
released Soundspan fix. The bounded transport and engine adapter are enabled in
local candidate builds only. Desktop real-decoder tests passed MP3, WebM/Opus, AAC, MP4 and a
mixed MP3/WebM/AAC queue, including reopening a completed MediaSource by appending
the next source without replacing the audio URL. Unit tests exposed and fixed
concurrent seek/pump and superseded seek races. Actual app integration, physical
acceptance and release gates remain outstanding. The Realme is disconnected.

Evidence: `pixel-continuous-valid-player.jsonl`,
`pixel-continuous-valid-result.json`, `buffer-browser-results.json`, and
`buffer-browser-reopen-results.json` in the private diagnostic directory.

## Candidate application validation

An actual-engine Pixel run used three OPFS WebM/Opus recordings already on the
device. Its 88 samples span 1,006.742 seconds, with three natural transitions,
Chrome FGS retained, active output and progressing frame counts in every sample.
The monitoring script intentionally paused at 18:47:44 Moscow when volume rose
above its configured quiet threshold; this is not an unsolicited playback stop.
Two samples were awake. The captured page reported no media or engine errors.

After the user restored screen locking, a separate 20-minute isolated-engine run
completed with Wi-Fi/data disabled. All 103 samples (1,189.73 seconds between
first and last samples) were dozing/asleep, retained FGS and active output, and
advanced AudioFlinger frames. Five recording changes were observed. The monitor
paused intentionally and restored connectivity at completion. This run still
uses the engine shell, not the full React application.

The first full-application local test exposed a preload timing defect that the
isolated engine fixture did not: a next-source lease could belong to the previous
native transport. The candidate waits for pending timeline initialization and
rebinds an already-acquired device preload after current-source load, while
preserving an acquisition still in flight. A real built-app test with an isolated
local account then completed three downloaded AAC tracks with exactly one native
source load. Repeat-one and repeat-all also retained one source across boundaries.
No production authentication or listening history was used by these tests.

Backward seek was separately checked against real decoded ranges: seeking from
90 seconds to 5 seconds retained the requested range and the subsequent queue
completed. Unit tests cover pending-load pause/cancel, superseded seeks, repeat,
and external playback authority. Independent review found and corrected a
Listen Together follower violation: membership changes now synchronously remove
continuous future audio and return the current file to the native transport.

Candidate frontend validation: 1,731 unit tests and 1,377 component tests passed;
typecheck and production build passed. ESLint reported no errors (105 warnings).
The actual app's long physical locked/offline acceptance remains required before
deployment. The format probe supports recognized MP3, ADTS AAC and WebM audio;
the core MP4 fixture result does not imply generic downloaded MP4 activation.

## Artifacts and cleanup

Private raw evidence and a sanitized summary remain outside Git under the sibling
soundspan/diagnostics/playback-20260919 directory. Relevant files include
physical-summary.json, pixel-low-volume.jsonl, pixel-low-volume-processes-private.txt,
pixel-elements.json and realme-parallel.jsonl. Do not publish raw process dumps or
owner-scoped diagnostic records. Wi-Fi and mobile data were restored on both
phones; playback was paused. Pixel was returned to mute. No app data was cleared.
