# Device Offline

Device Offline stores user-selected complete tracks in the browser without a
server-side bulk-download job.

- `DeviceOfflineProvider.tsx` owns the active user's reconciled download list
  and publishes only verified ready records to the synchronous player resolver.
- `downloadManager.ts` coordinates foreground or live-capability Android
  Background Fetch transfers. Metadata lives in IndexedDB; audio is committed
  atomically to the dedicated CacheStorage cache under an opaque virtual URL.
- Foreground transfers publish a renewable per-attempt lease so another tab
  cannot mistake an active download for an interrupted one. A missing browser
  Background Fetch registration receives one bounded completion grace while
  the service worker claims and publishes the completed response.
- Playback-visible metadata changes publish an opaque same-origin generation
  signal so other tabs reload only their active owner's records. Lease-only
  renewals stay local, and a failed IndexedDB open is retried by the next read.
- `public/sw.js` serves `/__offline/audio/<key>` and single byte ranges, keeps
  audio across service-worker updates, and completes Background Fetch state.
  Installation caches both offline documents and every discovered same-origin
  Next.js runtime chunk before publishing the new shell; a failed critical
  fetch leaves the previous worker and cache active.
- Library > Downloads is the management surface for play, retry, and delete.

iPhone/iPad transfers are foreground-only and an interrupted retry restarts the
track. Each device must download its own copy while online; after that, the PWA
can open Library > Downloads and play or seek that copy without reaching the
Soundspan server. Browser storage remains subject to platform eviction when
persistence is not granted.
