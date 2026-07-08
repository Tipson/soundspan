# soundspan 1.6.0

A big one: paste-a-YouTube-link streaming and downloads, podcasts and music in one queue, faster mobile loads, feature flags for the ML subsystems, and a top-to-bottom security hardening pass. Read the **Before you upgrade** section — two changes can affect existing deployments.

## YouTube link paste

Paste any YouTube link into the search page and it plays instantly. Admins can go further and download the audio straight into the music library — a single video, or a whole playlist or channel with "Download all" (great for long DJ sets). Downloads run as background jobs with live progress, and the finished files are imported automatically even if you navigate away mid-download.

- Channel downloads are grouped under one artist (the channel) so a 200-video archive doesn't shatter into dozens of "Unknown Artist" entries; playlist downloads keep each track's real artist.
- Bulk downloads no longer trigger a library rescan per file — scans are coalesced into at most one running and one follow-up.
- Requires the ytmusic-streamer sidecar with the shared music volume mounted (`/music`, configurable via `YT_DOWNLOAD_DIR`). Multi-node Helm clusters need that volume to be RWX.

## Podcasts and music, one queue

Podcast episodes and music tracks now live together in a single play queue. Queue an album behind the episode you're listening to (or episodes behind your music) — next/previous and auto-advance walk the whole queue across media types, episode progress is saved when you skip away, and partially-listened episodes resume where you left off instead of restarting. Older clients' saved queues migrate automatically.

## Faster on mobile

- Cover art is resized server-side (and served as WebP where supported) instead of shipping multi-megapixel originals to thumbnail-sized views.
- API traffic streams through the frontend proxy, preserving compression and streaming; the heavyweight video engine only loads when a segmented stream actually needs it (~730 kB less JavaScript on first load).
- Presence/notification polling pauses while the tab is hidden.

## Feature flags for the ML subsystems

Three coarse flags — `AUDIO_ANALYSIS_ENABLED`, `DISCOVERY_ENABLED`, `AUTO_PLAYLISTS_ENABLED` (all default **on**) — let you turn off audio analysis, Discover Weekly/recommendations, and auto-generated mixes per deployment. Disabled features return a clean `FEATURE_DISABLED` response, their background workers don't start, and the UI hides the corresponding sections. Available as Helm values (`config.features.*`) and now forwarded by Docker Compose too.

## Security hardening

This release lands the Wave-1 security program (independently reviewed, with follow-up fixes applied on review):

- **Stored secrets**: the settings cipher moved to authenticated AES-256-GCM with fail-closed decryption; API keys are now hashed (HMAC-SHA256) at rest. Both are fully backwards-compatible — existing data keeps decrypting and existing device keys keep working with no re-pairing. Optional migration scripts (`migrate-settings-to-gcm.ts`, `hash-existing-api-keys.ts`, both dry-run by default) plus a new admin `secrets-status` endpoint let you finish the migration on your own schedule.
- **Helm installs no longer lose secrets on upgrade**: the chart reuses the existing in-cluster Secret instead of re-rolling `SESSION_SECRET`, `SETTINGS_ENCRYPTION_KEY`, `INTERNAL_API_SECRET`, and `POSTGRES_PASSWORD` on every `helm upgrade` (previously a routine upgrade could log everyone out and make encrypted settings unrecoverable). Note: GitOps tools that render client-side (ArgoCD default mode, `helm template | kubectl apply`) can't use the reuse path — set `secrets.existingSecret` there.
- **Request path**: `ALLOWED_ORIGINS` is actually enforced now (including audio streams, cover art, and the Listen Together polling transport); JWT verification is pinned to HS256; session cookies default to `secure` in production; `TRUST_PROXY_HOPS` enables spoof-resistant rate limiting; the Lidarr webhook is rate-limited and unmatched events coalesce into a single scan; outbound fetches of untrusted URLs (podcast feeds and their redirects, image proxy, cover downloads) now DNS-resolve and reject private/loopback targets.
- **Odds and ends**: YouTube downloads are admin-only server-side; the download sidecar no longer accepts caller-supplied output paths; external cover art fetches are size- and pixel-capped; internal analyzer callbacks fail closed; device-link verification is race-safe; invite codes can't be over-consumed by concurrent registrations.

## Library scanner fixes

- Albums are resolved by release-group MBID first, so two different albums sharing a title no longer merge into one.
- Compilations with inconsistent artist tags no longer crash the scanner or get flagged unreadable on every rescan, and untagged files no longer split into duplicate albums when their tagged siblings already created one.
- Albums wrongly merged by older versions don't un-merge on a routine rescan — run a forced full re-scan to apply the corrected grouping retroactively.
- Opus/OGG durations import correctly (no more 0:00 YouTube downloads).

## Reliability

Discover Weekly failures now retry instead of being silently marked successful; auto-mix shuffling is genuinely random (and still deterministic per day); the scan queue no longer grows Redis unbounded; audio streaming survives client disconnects cleanly; queue edge cases around episodes (rapid skips, shuffle seeding, resume positions, removing the last item) are fixed.

## Before you upgrade

1. **`ALLOWED_ORIGINS` is enforced.** Same-origin deployments (the default `/api` proxy) are unaffected. But if your browser reaches the backend on a different origin (`NEXT_PUBLIC_API_URL` set, or `NEXT_PUBLIC_API_PATH_MODE=direct`) from a LAN IP or reverse-proxy domain, add that origin to `ALLOWED_ORIGINS` or API requests will fail CORS preflight.
2. **Secure cookies default on in production.** If you run `NODE_ENV=production` over plain HTTP (e.g. LAN without TLS — note Docker Compose sets production mode by default), set `SECURE_COOKIES=false` or logins won't persist.
3. **Recommended:** set a Lidarr webhook secret (System Settings → `lidarrWebhookSecret`, mirrored as an `x-webhook-secret` header on the Lidarr connection). The webhook works without one but logs a warning on every call.
4. **Optional:** run the two secret-migration scripts to move all stored values onto the new cipher and key hashing — see `docs/UPGRADING.md` for the exact steps and safety checks.

Full details for every change are in `CHANGELOG.md` under 1.6.0, and operator-facing upgrade specifics live in `docs/UPGRADING.md`.
