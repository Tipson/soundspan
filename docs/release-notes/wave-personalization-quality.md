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

The mood provider initially hit its existing short deadline during comparison. A separate read-only check returned compatible 512-dimensional spaces and a valid focus vector (space check 331 ms, text embedding 241 ms). Audio-feature fallback remains available. Acoustic labels can be imperfect; subjective fit still requires listening feedback.

Language selection is not shipped: the catalog does not contain reliable sung-language metadata. Classifying artist nationality or title script as sung language would mislabel multilingual and instrumental recordings. This requires a distinct metadata/classification step and agreed unknown-language behavior.

## Release and rollback

Release status, 8 September 2026: executable changes are committed as `e268daf1`; production has not been changed. Backend recommendation/API checks passed (333 tests), frontend component checks passed (15 tests), local backend compilation and the production frontend image build passed. The separate complete frontend typecheck has not run yet.

Backend image assembly is blocked on external dependency downloads: npm timed out, Prisma engine postinstall connections reset, and one install stalled. A build-only host-network attempt also returned `ECONNRESET`; repeated attempts were stopped under the repository debugging rule. API/worker package manifests, lockfile, Prisma schema/configuration and the shared contract have no differences from the deployed `0431e5c2` revision. A proposed next step is to reuse those unchanged installed dependencies in derived images, with compilation and runtime checks; this has not been executed.

The connected Android disappeared from the USB device list before release verification. Its acceptance check remains open. All three existing production roles were verified healthy and retain their prior tags (`analysis-wave-0431e5c2` API/worker, `android-ba4889cc` frontend).

Build the backend API, worker and frontend from one revision. No schema migration, recommendation-rollout change, analysis-budget change, new dependency, or credentials are part of this package.

Preserve the deployed compose overlay and all three previous image tags. Change only these image references; verify compose configuration, container health, frontend-to-API health, Wave playback and retuning. Restore the overlay and recreate only these three services if checks fail. Existing likes, history and downloaded files are not deleted.

## Risk review

- Checked account-scoped queries, finite candidate/seed limits, fallback failures, strict cooldown with sparse lanes, Home compatibility, old liked tracks and failed starts, manual long-track playback scope, and continuation with short pages.
- The Home launcher bypass discovered during review is covered by a component regression test and corrected to use the dedicated Wave feed.
- Residual limits: reads are bounded; different uploads without resolved canonical identity can still resemble repeats. No claim of perfect genre or language classification. No sustained multi-user load acceptance is made by this change.
