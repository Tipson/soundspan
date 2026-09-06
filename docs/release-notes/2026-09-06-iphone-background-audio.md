# iPhone background audio: physical-device investigation, 2026-09-06

Status: physical-device failure unresolved; targeted code corrections prepared locally, no production release from these experiments.

## Observed failure

USB Web Inspector attached to the installed Soundspan page (standalone mode,
SafariViewService). The existing track advanced while the document was hidden.
After its natural end, the next track emitted `playing` but its native media
clock froze at approximately 0.259 seconds. Its entire 135.7935-second duration
was buffered, readyState was 4, muted was false, volume and playbackRate were 1.
This occurrence was not waiting for additional audio bytes.

The user also reported silence while the displayed time advanced. Time progress
and a resolved play promise must not be treated as proof of audible output.
Unlocking temporarily restored sound; the playback watchdog subsequently emitted
its generic buffer timeout and the UI displayed the retry control.

## Bounded runtime experiments

All changes were temporary instrumentation in this user's page, not product code.

1. Reload the existing element once after a buffered hidden stall, restore its
   position and play: failed. Position moved from 0.262 to 0.513 seconds and froze.
2. Reset audioSession type from auto back to playback and retry play: failed.
   Position remained approximately 0.513 seconds.
3. Attach the existing detached element to the document and repeat the bounded
   reload: failed. Another roughly 0.25 seconds advanced, followed by a timeout.

The production audioSession playback setting was already active. None of these
experiments establishes that the fault is exclusively WebKit: application event
handling and the watchdog still participate. No unverified workaround is shipped.

## Next diagnostic gate

### Independent element experiment

A separate native audio element was added to the same page with its own controls
and a physical start button. It reused the captured audio URL, then reassigned
that URL on natural end. The user confirmed audible playback while unlocked.
The hidden transition advanced continuously to approximately 112 seconds, unlike
the original element. The user subsequently reported that sound was initially
audible while locked, but silent after the track ended; locked pause/play also
produced no sound. Consequently this experiment is NOT an audible-success result.
Its bounded single repeat makes the precise reported end-of-track boundary
ambiguous: the second natural end intentionally stops. Native clock advancement
does not override the user's report of silence.

The hardware media key delivered the test element's pause handler while hidden.
The first subsequent play callback was only observed much later, with its playing
event recorded when visible. Later samples also contain hidden lock-play and
playing events, but the user reports no audible resume. These events therefore
do not establish working locked-screen resume.

This is a partial isolation, not a clean application-free reproduction: Soundspan
remained mounted and its unexpected-stop watchdog continued logging. The test
also differs in controls, direct physical activation, crossOrigin defaults and
explicit load calls, and reuses one audio URL rather than two distinct tracks.
Those differences must be controlled before attributing the failure to a single
application or WebKit cause. No product fix has been accepted.

After three unsuccessful attempts, obtain approval before another fix attempt.
Build an isolated same-device reproduction without the application orchestrator
and watchdog, using the same audio and a single native element. Compare background
source transition and lock-screen pause/resume with the full application. Confirm
audibility with the user and repeat without Web Inspector before accepting a fix.

Local evidence: output/iphone-ready.log, iphone-recovery-controlled.log,
iphone-session-controlled.log and iphone-attached-recovery.log. These logs are
diagnostic artifacts, not release acceptance. Reload the test page to discard the
temporary prototype wrapper, event listeners and element attachment.

## Silent-session prototype: partial positive result

The user explicitly confirmed audible music after lock, silence after the remote
pause, and audible music after remote Play without unlocking. The prototype
swapped the same element to generated PCM silence during pause. This verifies
one physical pause/resume sequence, not production readiness. Position reset to
the beginning, and the user subsequently confirmed that automatic background
transitions still lost sound. Evidence: output/iphone-keepalive-ready.log.

## Transition-anchor candidate

The next prototype starts a separate silent element in the same physical gesture
as music, keeping it active before a natural source transition. It does not cut
off the track tail. The test is bounded and has an explicit stop button. The
ordinary application is still mounted; neither this setup nor simulated element
tests prove isolated WebKit behavior or actual audibility.

verify: node --test output/iphone-transition.test.cjs: 3 passed, 0 failed.
Tests cover anchor continuity across natural end, stale-ended rejection,
pause-position preservation and stopping both elements. Physical-device acceptance
is pending. There are no production changes from these prototype experiments.

## Targeted application corrections after device disconnection

Two concrete application behaviors were reproduced with failing regression tests:

1. Media Session action handlers were cleared and installed again on pause,
   resume and changed queue callbacks. The handlers remain registered for the
   local media session and read the latest committed controls. Clearing media
   and unmounting release them; selecting a paused item after clearing does not
   reacquire the OS controls until local playback starts.
2. The prepared iOS background handoff advanced the queue, but the subsequent
   load effect explicitly stopped/reset the primary audio element. The extended
   test includes the committed next-track load, not just the advance callback:
   it failed with one extra stop before the correction and passes without it.
   Only an active, prepared native network auto-advance in a hidden standalone
   iOS page avoids that stop. Manual and foreground switches, in-flight loads,
   shared sessions and provider cooldowns retain eager-stop behavior. Native
   source assignment replaces the existing element's source; it does not add a
   second audible element.

These are confirmed application defects, not a confirmed explanation of every
physical silent-output occurrence. Native source replacement still waits for
metadata before autoplay; this asynchronous boundary remains a diagnostic lead.
No silent-anchor prototype or new audio transport is included in this patch.

verify: component suite: 1231 passed, 0 failed. Includes 135 orchestrator and
6 Media Session tests; the handoff cases cover background, return to foreground
and a manual selection racing the automatic advance.

verify: native engine and policy suites: 127 passed, 0 failed.

verify: ESLint on the four changed TypeScript files: exit 0, no findings.

verify: frontend production build and complete frontend typecheck: exit 0.

Adversarial self-review: no additional confirmed code defect in the changed
paths. Physical audibility is an unresolved acceptance risk. A resolved play
promise, progressing UI clock or fake-element test does not establish sound.

Next physical acceptance: three different tracks with natural locked-screen
transitions, locked pause/resume, then the same sequence without Web Inspector.
Retain Safari as the working comparison. Do not mark the iPhone issue resolved
or roll an experimental workaround out to all users without this acceptance.
