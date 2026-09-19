# Android Back and offline playback — 2026-09-07

## Released changes

- `4922409c`: prioritized Back/Escape handling for the expanded player, nested player panels, shared modals, track menu and mobile sidebar. Closing a layer preserves the underlying route.
- `4922409c`: permission-gated migration of legacy directory downloads to private OPFS storage. Publication uses the existing owner lease and compare-and-swap; original files remain intact.
- `b218ce55`: starting a download replaces the previous queue with ready local tracks in displayed order, excluding pending/error entries and deduplicating track IDs. Ordinary playback callers retain their existing behavior.
- `b218ce55`: distinct active sidebar library tabs, closing on tab-only navigation, and hiding the install action inside standalone PWA.

## Verification

verify: first package — 157 targeted tests, frontend typecheck and production Docker build passed; lint had no errors and five existing warnings. Second package — 64 focused tests, typecheck, lint without errors and production Docker build passed. The counts overlap; they are not a unique combined total.

verify: connected Pixel 10 Pro — Back closes the expanded player or its top nested playlist/queue window without navigating the underlying page. All 20 legacy ready copies migrated: 347 private ready records remain, alongside three existing error records. All 20 original public-folder files remain intact. Relaunch/reload did not show the permission request.

verify: Wi-Fi and mobile data disabled — 20 consecutive Next actions each reached a playing local blob with readyState 4 and more than one second of advancing playback. Previous, seek, Pause/Play, foreground automatic transition, offline PWA opening, playback after reload, and navigation to Downloads passed. A migrated Heavy Is the Crown copy played offline. Evidence is audio-engine state, not acoustic verification.

verify: network restored to Wi-Fi enabled and mobile data enabled; navigator.onLine=true. Player paused in Downloads at handoff.

## Deployment and rollback

Frontend-only production image: `local/soundspan-frontend:android-b218ce55`, revision `b218ce55fcadce91a0e6be15d1db78a599f63cae`. Container health is healthy; `/login`, `/library`, `/vibe`, `/runtime-config` and `/api/health` passed smoke checks. Backend, worker, Hybrid percentage and analysis budgets were not changed. No git push was performed.

The release overlay is `/srv/music/soundspan-releases/b0-b340a7c/compose.json` inside CT 121. The saved overlay `compose-before-android-b218ce55.json` selects the preceding `android-4922409c` frontend. Restore that overlay and run the existing production Compose invocation with `up -d --no-deps frontend`; verify frontend health and the five smoke routes. Preserve other services and the private environment file. The deployment helper performs this rollback automatically if health verification fails.

## Remaining coverage and UX

- Main mobile screens were inspected; this is not exhaustive coverage of every nested window or playlist detail.
- Locked-screen offline transitions and playback after rebooting Android were not verified in this pass.
- Uncached artwork can show a fallback offline. The home-page radio failure copy incorrectly suggests the online catalog remains available while offline; this remains a separate UX correction.
- Three pre-existing failed download records were not presented as ready or silently deleted.
