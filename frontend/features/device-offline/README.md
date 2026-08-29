# Device Offline

Device Offline stores user-selected complete tracks in the browser without a
server-side bulk-download job.

- `DeviceOfflineProvider.tsx` owns the active user's reconciled download list
  and publishes only verified ready records to the synchronous player resolver.
  It also resumes the foreground-only collection queue on mount, focus,
  visibility, and network restoration without emitting offline error toasts.
- `offlineQueue.ts` and `browserQueueStorage.ts` keep a second, owner-scoped
  IndexedDB queue for album batches and optional liked-song automation. Atomic
  leases enforce one foreground transfer per owner across tabs; identity plus
  quality de-duplicates work, and completed items leave the queue only after
  the download manager publishes verified ready metadata.
- `downloadManager.ts` coordinates observable foreground transfers on Android,
  iPhone, and desktop. Chromium Background Fetch is intentionally disabled for
  new transfers because dynamically spooled responses can remain at 0% without
  a reliable completion signal. Metadata lives in IndexedDB; audio is committed
  atomically to the dedicated CacheStorage cache under an opaque virtual URL.
- Foreground transfers publish a renewable per-attempt lease so another tab
  cannot mistake an active download for an interrupted one. Legacy Background
  Fetch registrations are retired independently of media metadata: mount,
  focus, controller changes, and service-worker activation enumerate every
  Soundspan-prefixed browser registration and retry an uncertain abort with
  bounded backoff. This also clears orphan notifications after a record was
  deleted or replaced. Failed/aborted events become retryable, and success is
  published only after the retained body matches its declared byte length.
- Foreground readers publish throttled measured-byte progress (percentage when
  Content-Length is available, indeterminate bytes otherwise) while ready
  remains gated on the final CacheStorage integrity check.
- Playback-visible metadata changes publish an opaque same-origin generation
  signal so other tabs reload only their active owner's records. Lease-only
  renewals stay local, and a failed IndexedDB open is retried by the next read.
  A read failure keeps the last successful owner-scoped snapshot visible and
  presents Retry in Downloads and ordinary Settings instead of publishing a
  false empty collection.
- Downloads playback first materializes the verified CacheStorage response as
  a short-lived local Blob URL, so pressing Play does not depend on a network
  route or a newly activated service worker. `public/sw.js` also serves
  `/__offline/audio/<key>` and single byte ranges for queued playback, keeps
  audio across service-worker updates, and safely completes legacy Background
  Fetch state.
  Installation caches both offline documents and every discovered same-origin
  Next.js runtime chunk before publishing the new shell; a failed critical
  fetch leaves the previous worker and cache active. The v3-to-v4 worker
  migration preserves device audio, retires old Background Fetch jobs, and
  navigates every already-open client once per worker activation so an old
  JavaScript bundle cannot create another stuck transfer even when its shell
  cache was already evicted. Primary Library navigation on both mobile and
  desktop hard-loads the precached Downloads document while offline, avoiding
  an uncached Next.js route-transition request. A waiting worker defers that
  activation only when the current JavaScript runtime has both an active player
  state and a fresh engine heartbeat; a stale persisted play flag cannot hold
  an update forever.
- Album, artist, owned-playlist, My Liked, and YouTube Music collection pages
  can queue their currently playable tracks with `Download to this device`.
  Artist downloads are deliberately bounded to the top tracks exposed on the
  page instead of crawling an unbounded discography. Library > Downloads shows
  queued, active, interrupted, failed, and verified-ready states and is the
  management surface for play, retry, and delete. Choosing a whole collection
  also promotes any automatic liked copies in it to manual retention without
  fetching the same bytes again.
- Settings > Offline on this device can opt in to gradual liked-song downloads.
  The default is off. The current browser imports up to the selected 25, 50,
  100, or 200 newest liked songs and resumes only while the PWA is visible and
  online. Automatic copies are capped at 2 GiB and the selected track count;
  eviction removes only the oldest `auto-liked` records. A copy selected
  manually is promoted to `manual` and is never removed by automatic quota
  enforcement.

Transfers are foreground-only and an interrupted retry restarts the track. Each
browser profile on each device owns its own IndexedDB metadata and CacheStorage
bytes; local ready/delete state is never synchronized through the server. After
one device downloads a copy while online, its PWA can open Library > Downloads
and play or seek that copy without reaching the Soundspan server. Browser
storage remains subject to platform eviction when persistence is not granted.
The server synchronizes likes and playlists, not queue state, ready status, or
audio bytes; another device or browser profile therefore starts with no local
copies even for the same account. Deleting a copy requires confirmation that
only the current device is affected.
