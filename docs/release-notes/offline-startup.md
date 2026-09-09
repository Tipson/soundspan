# Offline PWA startup

## Scope

Frontend-only correction for startup blocked before downloaded music becomes accessible. No music-service restart, database migration, cache namespace change, or device-audio deletion.

`/runtime-config` is a beforeInteractive script. A network-first worker request without a deadline can block hydration even when the document and script already exist locally. AuthProvider also previously waited for a server request before restoring a cached offline identity.

- Known offline: cached document/configuration and the last validated local account do not wait for network requests.
- Uncertain connectivity: configuration headers and body have one 1.5-second deadline before cached fallback. Document navigation retains its five-second network budget.
- Online: configuration remains network-first. Server authorization and explicit 401/403 handling are unchanged.
- Local identity requires a saved credential; replacement URL tokens revoke old identity before the offline branch. Download storage remains owner-scoped.

## Verification

- Regression tests first failed for network-free offline bootstrap, stalled configuration headers/body, and cached auth startup.
- Worker, release bundle, build stamp and offline-session unit suites: 41 passing.
- Auth rotation, layout, device-offline provider and worker-registration component suites: 36 passing.
- Production webpack build, standalone TypeScript check and targeted ESLint: exit 0.
- Browser fault injection into the existing production worker: a stalled configuration left the downloads document at `Загрузка…` after four seconds. This controlled reproduction is not a measured minute-long phone startup.

## Adversarial review

Verdict: CLEAN for the bounded diff. Tests cover offline cache access, fresh online configuration, response-body stall, auth replacement, logout, stale async session results, downloaded audio preservation and existing active-client update policy.

Residual: a first-ever visit without an installed offline shell cannot work offline. An unavailable connection with `navigator.onLine=true` can still use the existing API timeout policy. Actual phone launch time requires a connected device; USB was unavailable during development.

## Release and rollback

Package the verified `.next` and stamped `public` output on top of the current frontend image. Back up the current compose overlay before changing only `services.frontend.image`. Recreate frontend alone, verify health and unchanged neighboring container IDs. Restore that saved overlay and recreate frontend to roll back. Do not restore an older unrelated music-service overlay.

Users must open the app online once to receive and precache the updated worker and bundle before testing an offline restart. Existing audio copies must not be cleared.
