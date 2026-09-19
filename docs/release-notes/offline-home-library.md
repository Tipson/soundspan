# Offline landing and Library tabs — 2026-09-07

Code revision: `9916b280ecf21451cd9344dc1896a2625ef2c118`.

- Offline Home renders Downloads directly, without mounting online feed queries. This preserves the shared player and does not automatically replace its queue.
- Library query-only tabs use Next's supported native history integration instead of an RSC navigation. Offline tabs retain their destination and show an explicit full-collection-unavailable notice plus the device download list.
- A provider failure with browser connectivity still present does not prove the whole network is offline. Its notice offers Downloads without claiming the online catalog is operational or forcing navigation.
- Track queue rows omit the inline removal cross; removal remains in the overflow menu. Podcast episode controls are unchanged.

verify: 42 Home/Library-tabs/queue/download component tests and one network-event test passed. Changed-code ESLint passed. Clean production Docker build including TypeScript passed. Android was disconnected; no real-device offline retest is claimed.

Yandex reference: https://www.yandex.ru/support/music/ru/listening/listening-offline — downloaded tracks are available on their device in offline mode. The documentation does not establish automatic navigation on every transient connection failure. This implementation borrows the downloaded-content-first principle, not a claim of identical behavior.

Scope limits: offline album/artist/playlist grouping is not implemented here; these tabs show the shared download list with an explanation. Browser onLine is a connectivity hint, not server reachability. Cold uncached-document fallback in the service worker remains unchanged; the cached homepage now provides a useful offline surface. End-to-end device testing remains required.

verify: production image `local/soundspan-frontend:android-9916b280` passed health and HTTP 200 checks on `/runtime-config`, `/login`, `/api/health`, `/library`, `/vibe`. The frontend-only release retained the previous `android-5e464d17` configuration in `compose-before-android-9916b280.json`. Backend, worker and media storage are unchanged. No git push.
