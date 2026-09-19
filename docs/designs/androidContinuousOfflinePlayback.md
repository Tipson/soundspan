# Continuous offline playback on Android

Status: implemented candidate; production acceptance pending

## Outcome and evidence

Downloaded tracks must advance naturally with the screen locked and no network.
Manual pause, seek, queue replacement and account cleanup retain their meaning.
Physical acceptance requires progressing native audio output, not just a PLAYING
MediaSession label. See the Android offline acceptance release note for evidence.

The Pixel reproduces a loss of Chrome's foreground service at native file
boundaries and a frozen output around 68–69 seconds into the following file.
Changing MediaSession state, requesting play earlier, and selecting Howler do
not independently prevent it. A loop-based experiment had one successful run
but failed another and can replay the old file's beginning. It is not a release
candidate. A continuous MediaSource transport is being physically evaluated.

## Selected design

Keep the AudioEngine contract, native output element, queue controls, offline
source leases and recovery ownership. An internal adapter uses one MediaSource
URL across prepared local track boundaries. It translates the continuous native
timeline into the current track's relative position and emits one logical end
per occurrence. Promoting an already appended next track does not replace src,
pause the element. endOfStream flushes a completely supplied tail; a later append
reopens the same MediaSource without replacing its URL.

The transport is isolated from queue selection. It may stage only the source
explicitly provided through preload. Load adopts that staged source only when
the exact source identity matches; arbitrary/manual selections use a fresh
generation. Cancelling a preload prevents stale future audio from being emitted.
Neither stale callbacks nor account cleanup may revive playback.

Read local blobs in 64 KiB slices. Retain only current and next source handles.
Keep roughly 30 seconds of decoded audio ahead and 15 seconds behind. Seeking
outside retained ranges must refill from the existing local source without
requiring connectivity or retaining entire recordings as JS ArrayBuffers.
Serialize append/remove/changeType operations and release all listeners, object
URLs, source handles and pending work when ownership changes or playback ends.

Probe actual container compatibility; do not infer it from a filename. Browser
integration tests cover MP3, WebM/Opus and supported AAC/MP4 fixtures, including
format changes. An unsupported format must take an explicit tested fallback;
it cannot silently be declared fixed by the successful MP3 case.

Limit selection to verified Android/browser environments with MediaSource
support. Other platforms retain their established engine. Candidate builds enable
the adapter; production rollout remains blocked until full-app locked-phone
acceptance succeeds. Active or pending Listen Together membership synchronously
disables continuity, removes prepared future audio, and returns the current file
to native playback at its track-relative position.

## Alternatives rejected or deferred

- Timers and retries cannot execute in a frozen Chrome process.
- Forcing MediaSession PLAYING does not keep native output alive.
- Loop/seek tricks did not reproduce reliably and risk repeating audio.
- Howler reproduced the same physical stop on the Pixel.
- A native Android player would own its foreground service but would not fix
  the installed PWA; it is not the first implementation path.

## Acceptance and release

First validate the transport with synthetic browser fixtures and an isolated
physical stream. Then exercise the real Soundspan engine and downloaded queue:
30 minutes offline with screen off on Pixel, parallel Realme, natural handoffs,
shuffle constrained to downloaded tracks, manual pause/resume, seek, repeat,
queue end, queue replacement, and cancellation during load. A fixture-only pass
does not satisfy real-app acceptance. No deployment until tests, build, review
and rollback preparation are complete.
