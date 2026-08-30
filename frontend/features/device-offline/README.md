# Device Offline

Device Offline retains complete audio files on the current device. It never
creates a server-side bulk-download job and it never treats a browser cache as
the final destination for a new download.

- `vault/` is the deep device-file module. The production web adapter prefers
  the File System Access API and writes owner-scoped files below a directory
  chosen by the user. When a browser cannot expose such a directory, it uses
  writable Origin Private File System storage on that browser profile/device.
  Its public seam (`DeviceAudioVault`) also allows a future Capacitor adapter
  to use Android or iOS app-private files without changing queue, collection,
  or player callers.
- `DeviceOfflineProvider.tsx` inspects access without prompting. A manual track
  or collection action calls `requestAccess()` directly from the user's click
  before it queues work. Automatic liked-song downloads never open a picker and
  remain paused until device storage is ready.
- Chrome and Edge on desktop, plus browsers on Android that expose
  `showDirectoryPicker`, can select a normal device folder. Safari, Firefox,
  iOS web apps, and other browsers without a directory picker use OPFS only
  when writable file streams are available. OPFS is intentionally reported as
  private per-device storage; it is not presented as a user-visible folder. A
  ready OPFS track offers an explicit **Save as file** action in Downloads. The
  browser or operating system chooses the destination and receives a separate
  ordinary file; the managed OPFS copy remains in place for reliable offline
  playback. Browsers can block, rename, or prompt for that export, so Soundspan
  reports that the save action opened rather than claiming the external copy
  was persisted. Older browsers without either writable route remain
  unsupported.
- `downloadManager.ts` streams each new response into the active vault,
  publishes measured-byte progress, and marks metadata ready only after the
  retained file passes integrity checks. Metadata and the owner-scoped work
  queue remain in IndexedDB; the audio bytes live in the selected device
  folder or the browser-private OPFS fallback.
- `offlineQueue.ts` and `browserQueueStorage.ts` de-duplicate album, artist,
  playlist, and My Liked work by owner, track identity, and quality. Renewable
  leases ensure one foreground transfer per owner across tabs. Interrupted work
  resumes only while the app is visible, online, and storage is ready.
- Playback opens a short-lived revocable URL from the device file. The player
  owns that lease and releases it on replacement, error, account rotation, or
  unmount, so an offline play does not require the Soundspan server.
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
- Settings can opt in to gradual liked-song downloads after storage setup. The
  default is off. Automatic copies are capped by the selected 25, 50, 100, or
  200 newest liked songs and by 2 GiB; eviction removes only the oldest
  `auto-liked` files. A manually selected copy is promoted to `manual`.

Transfers in the web app are foreground-only: keep Soundspan open until the
current file finishes. Every browser profile or native installation has its own
storage setup, queue, and ready state; audio files are owner-scoped below its
selected folder or private OPFS root. The server synchronizes likes and
playlists, but not device file status; downloading on one phone does not mark a
second phone or a computer as downloaded. Deleting a file affects only the
current device and requires an explicit confirmation. An ordinary file exported
through the browser belongs to the user and is not tracked or deleted by
Soundspan.
