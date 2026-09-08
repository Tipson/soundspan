# Wave personalization quality

## Scope

- Collection signals: bounded reads of 2,000 likes and 2,000 playlist records instead of 100. Playback taste weighting keeps its 100-observation window; repeat exclusion can inspect the latest 1,000 plays.
- Wave seed selection: at most three distinct artists. Equal-strength collection candidates use a deterministic account/listening/cursor tie-break rather than import order.
- Wave cooldown: exclude actual non-failed plays in the preceding 24 hours, plus recent canonical exposures, in both experiment arms. A depleted candidate pool stays short instead of being padded with repeats. Home's separate Listen Again shelf is preserved.
- Moods reorder personal candidates using available measured features (and hybrid semantic vectors). Generic background-music searches are removed.
- Automatic Wave excludes recordings of 30 minutes or more, and explicitly labelled compilations/full albums longer than ten minutes. Manual album, playlist and saved-track playback is unchanged.
- Home quick start uses the Wave query/cache and the same lane selector as `/vibe`, rather than launching Home's Listen Again recommendations as Wave.

## Evidence and limits

Account baseline was captured without changing likes or playback history. Dartum had 343 likes, of which only 100 reached the old catalog profile; Laurisoul had ten.

Controlled replay (fixed account signals, captured catalog candidates, optional ListenBrainz disabled) returned twelve already-played-in-24-hours tracks for each account before the change, zero after it. Maximum artist concentration fell from seven to two tracks. Fresh provider requests with the patch produced 23 tracks / 20 artists for Dartum and 18 tracks / 14 artists for Laurisoul, without the captured day's played IDs. These are bounded checks, not a long-term satisfaction score or load test.

The mood provider can take longer than the 750 ms caller budget (a measured cold text inference took 4,475 ms). The store keeps a coalesced fill alive for at most 15 seconds and caches a valid late result, instead of discarding it and disabling semantic mood for five minutes. Actual errors retain a five-minute cooldown. Model identity is revalidated every minute without recomputing a fixed prompt's vector in the same space. Audio-feature fallback remains available during a cold fill. Acoustic labels can be imperfect; subjective fit still requires listening feedback.

Language selection is not shipped: the catalog does not contain reliable sung-language metadata. Classifying artist nationality or title script as sung language would mislabel multilingual and instrumental recordings. This requires a distinct metadata/classification step and agreed unknown-language behavior.

## Release and rollback

Release status, 8 September 2026: core changes `e268daf1` and mood fixes `cf72575e` / `fdd94e7d` are deployed in API and worker images `wave-quality-fdd94e7d`. The existing frontend `ui-density-91b1e02d53b90e1061a94bde5e2bf6f6bb96607f` is preserved.

verify: backend build exit 0; 338 recommendation/catalog/API tests across 27 suites passed, including failing-first regressions for late mood completion and unchanged-space reuse. Derived API/worker images were built with networking disabled from the verified local `analysis-wave-0431e5c2` bases: package manifests, lockfile, Prisma schema/configuration and shared contract are unchanged. Both image runtime checks passed. This avoids the dependency-download failures of the earlier full-image attempt without substituting dependencies.

verify: production API and worker healthy; frontend `/api/health` and `/vibe` returned 200. The read-only deployed-code check returned Dartum 22 tracks / 19 artists and Laurisoul 18 / 14, no checked 24-hour played IDs, no tracks >=30 minutes, maximum two tracks per artist. Dartum focus returned without `dclap-mood` degradation in 638 ms and 458 ms. These are feed timings, not time to audible playback.

verify: an additional two-page read-only check using the same image and current production data returned Dartum 22 then 24 tracks, Laurisoul 14 then 12 after the UI listening check. Excluding first-page video IDs produced no cross-page repeats; the 24-hour and artist/duration guards passed on each page. Sparse personal catalogs can produce shorter pages rather than repeat-filled ones.

verify: browser account Laurisoul launched Wave, changed Any to Focus, then advanced twice. Player time progressed on `Как раньше`, `Я никогда не`, `11:11` and `Takin' You Down`; the original Any setting was restored and playback paused. These deliberate UI actions can record normal plays/skips; the separate account audit did not mutate history or preferences. A profile-image 404 and font preload warnings remain outside this Wave change. The Android USB list was empty, so a physical-phone check remains open. Browser timer progress is not an independent audible-output measurement.

Full backend coverage visibility is **not green** on this Windows environment: 559 suites passed, 27 failed, one skipped; 8,276 tests passed and 115 failed. The failing suites are outside the changed Wave units and include path/platform/environment failures; not every failure has been independently classified. They were not suppressed. This release does not close the whole-platform quality gate. The complete frontend typecheck remains unverified; no frontend source was changed in this release.

No schema migration, recommendation-rollout change, analysis-budget change, new dependency, or credentials are part of this package. Previous API/worker images are retained. Rollback overlay: `/srv/music/soundspan-releases/b0-b340a7c/compose-before-wave-quality-fdd94e7d.json`; restore it as `compose.json` and recreate only backend/backend-worker with the existing production compose layers. The deployment script automatically restores this overlay on a failed post-deploy gate. No forced-failure production rollback drill was performed. Existing likes, history and downloaded files are not deleted.

## Risk review

- Checked account-scoped queries, finite candidate/seed limits, fallback failures, strict cooldown with sparse lanes, Home compatibility, old liked tracks and failed starts, manual long-track playback scope, and continuation with short pages.
- The Home launcher bypass discovered during review is covered by a component regression test and corrected to use the dedicated Wave feed.
- One scoped adversarial pass of the mood/deployment delta: no unresolved P0/P1 found. Verified caller deadlines, coalescing ten callers, late rejection/invalid values/hard timeout, space changes and bounded four-mood cache; deployment changes only API/worker image references. The 15-second fill deadline does not cancel the provider transport, which retains its own timeout; the failure cooldown prevents repeated fills during that remaining request.
- Residual limits: reads are bounded; different uploads without resolved canonical identity can still resemble repeats. No claim of perfect genre or language classification. No sustained multi-user load acceptance is made by this change.
