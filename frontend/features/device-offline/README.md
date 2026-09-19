# Device Offline

Device Offline retains complete audio files on the current device. It never
creates a server-side bulk-download job and it never treats a browser cache as
the final destination for a new download.

- `vault/` is the deep device-file module. The production web adapter prefers
  the File System Access API on desktop and writes owner-scoped files below a
  directory chosen by the user. On Android it deliberately prefers writable
  Origin Private File System storage even when a directory picker exists, so
  managed audio is not exposed to gallery pickers and routine launches do not
  depend on renewed public-folder permission. Other browsers without a usable
  directory picker also use writable private storage when available.
  Persisted `fsa1` and `opfs1` references route back to the adapter that wrote
  them after a PWA restart, even if picker availability changes between app
  contexts.
  Its public seam (`DeviceAudioVault`) also allows a future Capacitor adapter
  to use Android or iOS app-private files without changing queue, collection,
  or player callers.
- `DeviceOfflineProvider.tsx` inspects access without prompting. A manual track
  or collection action calls `requestAccess()` directly from the user's click
  before it queues work. Automatic liked-song downloads never open a picker and
  remain paused until device storage is ready.
- Chrome and Edge on desktop can select a normal device folder. Android
  Chromium, Safari, Firefox, iOS web apps, and other browsers without a
  directory picker use OPFS only
  when writable file streams are available. OPFS is intentionally reported as
  private per-device storage; it is not presented as a user-visible folder. A
  ready OPFS track offers an explicit **Save as file** action in Downloads. The
  browser or operating system chooses the destination and receives a separate
  ordinary file; the managed OPFS copy remains in place for reliable offline
  playback. Browsers can block, rename, or prompt for that export, so Soundspan
  reports that the save action opened rather than claiming the external copy
  was persisted. Older browsers without either writable route remain
  unsupported. Existing Android `fsa1` records remain readable through their
  original directory adapter; Downloads exposes a separate reconnect action
  when the browser has forgotten that older folder permission. With private
  storage ready, granting access starts a sequential, owner-scoped copy of
  verified legacy files into OPFS. Metadata switches through compare-and-swap
  only after each file is retained successfully; failed or cancelled copies
  keep their original reference. Public-folder originals are never deleted.
  Successfully copied tracks do not depend on renewed folder permission.
- `downloadManager.ts` streams each new response into the active vault,
  publishes measured-byte progress, and marks metadata ready only after the
  retained file passes integrity checks. Metadata and the owner-scoped work
  queue remain in IndexedDB; the audio bytes live in the selected device
  folder or the browser-private OPFS fallback.
- Rejected HTTP responses and failures before storage acquires a stream reader
  cancel the unused response before a retry. After reader acquisition, the vault
  owns cancellation and partial-file cleanup. Cleanup failures do not replace
  the original download error.
- Retained files and subsequent inspect/play/export requests reject empty or
  truncated files and recognizable HTML/XML/JSON error documents, even when
  the server labels them as audio. Content inspection reads at most the first
  512 bytes; it does not decode the whole track or guarantee codec support.
  An invalid just-created file is discarded before publishing ready metadata.
  An existing invalid file is preserved for explicit user recovery, without
  issuing a playback or export URL.
- `offlineQueue.ts` and `browserQueueStorage.ts` de-duplicate album, artist,
  playlist, and My Liked work by owner, track identity, and quality. Renewable
  leases ensure one foreground transfer per owner across tabs. Interrupted work
  resumes only while the app is visible, online, and storage is ready. A
  transient per-track network, provider, or device-I/O failure receives two
  bounded retries; an exhausted or permanent failure remains retryable in the
  UI without preventing later collection tracks from completing.
- Playback opens a short-lived revocable URL from the device file. The player
  owns that lease and releases it on replacement, error, account rotation, or
  unmount, so an offline play does not require the Soundspan server.
  Starting a track from Downloads replaces the queue with the ready playable
  copies in the displayed order, respecting the current search and collapsing
  duplicate qualities of one track. Later searches and download progress do
  not mutate that queue. Offline listening does not resume an unrelated online
  Wave tail after the selected download finishes.
- OPFS requests durable browser retention before it is used. A denied or failed
  persistence request does not disable verified foreground playback, but the
  Downloads and Settings surfaces warn that browser data may be cleared and
  recommend saving an ordinary file. The ready record stores the real
  persistence result instead of assuming success.
- Records created by older releases may lack `mediaRef`. After the user
  selects a folder, verified legacy CacheStorage copies migrate file-first,
  switch metadata atomically, and only then remove the cache entry. CacheStorage
  is a transition path, not the destination for new files.
- Album, artist, playlist, My Liked, and YouTube Music collection pages
  queue the playable tracks currently exposed by the page. Artist downloads
  remain deliberately bounded instead of crawling an unbounded discography.
  Shared collection buttons use compact single-line visible labels; their
  accessible name and linked status retain the complete action, collection,
  progress, and storage explanation.
- Liked-song downloads default to enabled and wait for storage readiness.
  Policy version 2 normalizes the former default-off settings to enabled;
  an explicit pause saved under this policy survives reloads for that owner.
  The legacy count/byte fields store zero and impose no application limit.
  The complete liked collection is read in cursor pages of 500 with account,
  visibility and network checks around each request. Download work remains
  sequential and de-duplicated. Removing a like cancels pending automatic work
  without deleting retained files. A manually selected copy is promoted to
  `manual`. Automatic size/count eviction is not performed.
- A storage quota or permission failure persists `requiresStorageAction` and
  pauses owner-scoped queue admission across tabs. Settings explains the
  failure and offers an explicit retry after space or access is restored.
  A per-track provider failure remains separate so other tracks can finish.
  Settings also exposes failed liked-list refreshes rather than reporting a
  completed automatic queue. Retry retains existing files and ownership.

Transfers in the web app are foreground-only: keep Soundspan open until the
current file finishes. Every browser profile or native installation has its own
storage setup, queue, and ready state; audio files are owner-scoped below its
selected folder or private OPFS root. The server synchronizes likes and
playlists, but not device file status; downloading on one phone does not mark a
second phone or a computer as downloaded. Deleting a file affects only the
current device and requires an explicit confirmation. An ordinary file exported
through the browser belongs to the user and is not tracked or deleted by
Soundspan.
