# Android Back follow-up — 2026-09-07

Production frontend: `local/soundspan-frontend:android-5e464d17`.

The prior handler returned control to the router when a history traversal crossed the overlay's base URL. Two failing regression tests demonstrated that skipping the same-document guard could leave the overlay open while navigating beneath it. The handler restores the saved visible-route state before closing only the highest-priority layer. Existing ordinary navigation, nested dismissal and effect-replay tests remain green.

This package includes `bc209594`, which synchronizes Downloads rows with the current track and playing/paused status and toggles playback without resetting the current position.

verify: 8 history tests and 8 player/modal component tests passed. The Downloads package passed 30 component tests. Changed history files passed ESLint. Clean Docker production build, including TypeScript, passed. The earlier local Webpack build failed on generated page-export validation; that was not a successful production build and is not used as release evidence.

verify: frontend-only rollout passed health and HTTP 200 smoke checks on `/login`, `/library`, `/vibe`, `/runtime-config`, `/api/health`. Previous image is `android-b218ce55`; rollback overlay is `/srv/music/soundspan-releases/b0-b340a7c/compose-before-android-5e464d17.json` in CT 121. No backend or worker changes, no git push.

Scoped adversarial pass: preserved the visible route's Next state rather than the traversed destination's tree; nested windows retain their own guard; cleanup after real navigation and quick reopen remain covered. No new storage mutation or network request is introduced. Residual limitation: Android was disconnected (`adb devices` empty), so the user's exact device scenario has not been reverified. A cross-document browser navigation cannot be guaranteed by a same-document popstate test. Do not mark the reported device issue definitively closed until retested on the phone.
