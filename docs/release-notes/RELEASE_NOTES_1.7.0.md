# [1.7.0] Release Notes - 2026-07-10

A feature release with one big opt-in experiment and two fixes you'll hear immediately. The headline: a new native `<audio>`-element playback engine you can enable with a single environment variable, built to structurally eliminate double-play and background playback death. Also: generated radio stations and mixes stop being "the same three artists every time", playlists become reorderable (drag-and-drop included), and the background worker learns to name whoever is starving its event loop.

## A new playback engine (opt-in)

`STREAMING_ENGINE_MODE=native` switches direct playback from Howler.js to an engine that owns a single native `<audio>` element for its entire life. Setting a new track's `src` synchronously stops the old stream before the new one exists — the double-play bug class dies structurally, not by guard flags. End-of-track detection uses the browser's media pipeline (it works under locked-screen timer throttling), seeks issued before the track is ready are queued and applied on readiness (podcast/audiobook resume), autoplay-policy retries are bounded and honest (the UI can't show "playing" while nothing plays), and expired stream tokens after a long pause are recovered by reloading the source at position.

- Howler remains the **default** and the fallback: unset the variable and you're back, no image change.
- Installed iOS PWAs get a narrowly-gated AudioContext bridge that keeps background audio alive (WebKit bug 261858); everywhere else — desktop, Android, iOS Safari tabs — hi-res FLAC rides the bare element pipeline untouched.
- Android WebView deployments are automatically pinned to Howler (its Web Audio mode is the established crackling fix there).
- Every playback metric is now tagged with both the configured engine mode and the engine actually playing, so you can compare the two engines on your own deployment before switching.
- Listen Together got two fixes along the way, both engines benefit: the leader no longer restarts ~5 seconds into a skipped-to track, and followers no longer play a small blip of track-start audio before the synchronized start.

See `docs/NATIVE_AUDIO_ENGINE.md` for the full rollout/soak guide.

## Radio and mixes stop playing the same three artists

Genre radio (and most generated queues) had a compounding bias: genre matching pulled in entire discographies of broadly-tagged artists, database queries truncated the pool to the same slice every time, and no per-artist cap was applied. All queue generation now flows through one shared selector with **damped proportional artist weighting**: artists with bigger discographies still earn more slots than one-hit wonders, but nobody can dominate — there's a hard per-artist ceiling (default 30% of the queue). Genre stations also prefer per-track genre evidence over artist-level tags now.

- Applies everywhere: genre/decade/mood/workout/discovery/favorites radio, all daily and weekly mixes, mood buckets, and the Subsonic API's genre listing (which previously returned the same alphabetical page forever).
- Tunable: `GENERATION_ARTIST_WEIGHT_ALPHA` (0 = everyone equal, 1 = fully proportional; default 0.5) and `GENERATION_ARTIST_SHARE_CEILING` (default 0.3).
- Daily/weekly mixes stay deterministic per day — same mix all day, different composition across days.
- Expect your mixes to *sound different* after this upgrade. That's the fix working.

## Reorder your playlists (#27)

Drag the grip handle that appears when you hover a row (desktop), or use Move up / Move down / Move to top in the row menu (works on touch too). Reorders apply instantly and persist.

## Worker reliability, continued (#43)

The background worker now runs an event-loop stall watchdog: recoverable stalls log exactly which jobs were running, and the heavy queues leave a breadcrumb before starting work so even a liveness-probe kill names its culprit. The Helm chart gives the worker probe more busy-loop headroom (~2 minutes) since a busy single-threaded worker isn't a dead one.

## For contributors (#8)

`npm run setup` from a clean clone installs everything in the right order (no more `Cannot find module '@soundspan/media-metadata-contract'`), and `npm run verify` reproduces every CI gate locally. Node ≥ 20.9 is now declared in every package; `.nvmrc` pins 24.

## Before you upgrade

- **No schema migrations, no required config changes.** Drop-in upgrade from 1.6.x.
- The native engine is **off by default** — enable `STREAMING_ENGINE_MODE=native` per deployment when you're ready to try it, and flip it back anytime.
- Generated mixes and radio queues will have visibly different (more diverse) composition. Subsonic clients calling `getSongsByGenre` now get a shuffled selection that rotates daily instead of a fixed alphabetical list.
- Playback client metrics gained `engineMode`/`activeEngine` fields; if you scrape the logs, the shape is additive only.
