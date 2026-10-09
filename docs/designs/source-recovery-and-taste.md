# Source recovery and taste settings

Status: shipped and verified on production, 2026-09-20 (API/frontend 28548715, worker 66a7bfc8)

## Accepted scope

Complete the four authorized priorities without additional agents: audit and correct alternate playback, recover incomplete taste seeds, diagnose Redis listener ownership, and adapt the observed Yandex artist-selection flow to Soundspan. Preserve account boundaries, source credentials, existing downloads and playback. The owner performs git push.

## Implementation plan

- [x] Source fallback: trace real upstream status mapping and session/range guards in `routes/musicSourceFallback.ts`, `services/musicSources/fallback.ts`, resolver and matcher. Add behavioral failure/cancellation/version tests before fixes. Verify public provider health separately from simulated failures; retain explicit access restrictions.
- [x] Taste recovery: trace persistence and all consumers in `services/tasteProfile.ts` and the frontend feature. Persist recoverable selection state, expose incomplete resolution honestly, bound retries, and prevent stale retries replacing newer choices. Test transient and terminal errors, reload, skip and concurrent edits.
- [x] MaxListeners: reproduce with trace-warnings in an isolated process, identify attachment/teardown ownership, add a lifecycle regression test, then correct the owner rather than raising global listener limits.
- [x] Taste UI: replace the three-step dialog with artist-first selection, round portraits, genre filters and a persistent summary/save area. Preserve search, existing genres/artists, close/Escape/focus, error and loading states, account isolation and mobile usability. Use the live Yandex settings reference without changing its account preferences.
- [x] Run targeted tests during implementation; complete backend/frontend gates once for the release candidate. Apply ordinary and adversarial review, record actual limitations.
- [x] Commit locally, create verified backup/rollback, release the affected services, verify public API and desktop/mobile UI, update Obsidian task statuses.

## Reference

Observed at `https://music.yandex.ru/settings`: “Уточнить предпочтения” opens a broad artist grid with circular portraits and a horizontal genre filter. Desktop explanatory text sits in a left column with a save action; the main heading is “Выберите любимых исполнителей”. Soundspan retains its purple brand, searchable catalog and existing stored selections.
