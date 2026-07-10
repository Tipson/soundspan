# [1.8.0] Release Notes - 2026-07-10

The native `<audio>` engine graduates from opt-in experiment to **the default for everyone**, and this release fixes the three rough edges the first day of default-mode listening surfaced: cleared queues that came back from the dead, auto-advance occasionally landing on a paused track, and background tabs going silent between tracks. The Now Playing queue also becomes drag-and-drop reorderable, matching playlists.

## The native engine is now the default

If you set nothing, you're now on the engine introduced in 1.7.0 — single audio element for its whole life, structural double-play elimination, native end-of-track detection that works under background timer throttling. `STREAMING_ENGINE_MODE=howler` switches back instantly (the legacy engine remains fully supported as the gated fallback), and Android WebView deployments are still pinned to Howler automatically.

## Clearing the queue finally sticks (#52)

Clearing the queue removed your device's saved playback state — but a pre-device-era "legacy" state row survived on the server, and the next background sync helpfully re-adopted it, resurrecting the entire queue within a minute. An explicit clear now deletes the legacy row too. Multi-device users: opening the app on a brand-new device still inherits your last state as before; only *clearing* got stricter.

## Auto-advance always plays now (#53)

Two fixes, one guarantee — when a track ends, the next one plays unless something explicitly says otherwise (end of queue with repeat off, a Listen Together follower, or you paused):

- Advancing to the next track now *declares* "play this" to the loader instead of inferring it from UI state that was mid-flight during the track change. Under the native engine the browser fires `pause` just before `ended`, and losing that race left the next track loaded but paused, showing a Play button. Structural fix: the intent is stamped and consumed, not guessed.
- When the browser blocks autoplay because the tab is hidden (track changed while you were tabbed away), the engine now retries playback automatically the moment the tab becomes visible — you no longer have to click. If you paused in the meantime, it stays paused.

## Reorder the queue by dragging (#51)

The grip handle on upcoming Now Playing rows — previously decorative — now drags, with the same hover-reveal handle, drop-indicator, and semantics as playlist reordering (1.7.0). Podcast episodes in the queue got the same handle. This also fixed a latent bug: using Move up/down while shuffle was on silently corrupted the shuffle order; both paths now share one primitive that remaps it correctly. Upcoming rows only — the playing track and history stay put — and it's disabled during Listen Together sessions.

## Housekeeping

- The five backend radio test failures that shipped silently inside 1.7.0's generation-diversity work are repaired (test mocks hadn't been updated for the new config block and query shape). They never affected runtime behavior — production config always has the values the mocks lacked — but they made the backend suite red on main. The reason nobody noticed (the backend test job is non-blocking "visibility" in CI) is tracked with the broader gating gap in #54.

## Before you upgrade

- **No schema migrations.** Drop-in upgrade from 1.7.x.
- **Default engine change:** deployments that never set `STREAMING_ENGINE_MODE` switch to the native engine with this upgrade. Everything is designed to be inaudible; if anything sounds off, set `STREAMING_ENGINE_MODE=howler` and you're back on 1.6-era behavior without an image change.
- If a previously cleared-and-resurrected queue is still haunting a device, clear it once more after upgrading — this time it's gone for good.
