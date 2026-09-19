# Wave mood consistency — 2026-09-20

The mood selector contains «На своей волне», «Спокойно» and «Энергично». Old focus/workout selections map to calm/energetic; old favorites/forgotten mood selections map to neutral. Direction controls remain independent.

All Wave candidate lanes pass the same eligibility check after canonical audio-feature enrichment, before baseline or hybrid ranking: calm requires normalized finite arousal <= 0.45; energetic requires >= 0.55. Unknown analysis and RMS loudness cannot establish eligibility. Legacy API focus/workout use the corresponding eligibility families. Neutral Wave and other recommendation surfaces are unaffected. A short mood pool is not filled with incompatible recordings.

## Verification

- Backend coverage gate: 618 suites passed, 2 skipped; 8,758 tests passed, 9 skipped. Separate boundary suite: 2 passed.
- Frontend: 1,732 unit tests and 1,377 component tests passed. Linux typecheck, backend build and frontend production build passed. Frontend lint: 0 errors, 105 existing warnings.
- Paired read-only replay: 96 feeds across four real accounts, both ranking arms and six selection scenarios. Candidate queues satisfy mood eligibility; neutral queues have identical track IDs/order. No disliked recordings, same-day exposure violations, duplicate IDs or saved tracks in discoveries in the replay. Diagnostic replay does not write listening history or exposures.
- Hybrid production target remains 50% of sessions; this change does not modify experiment configuration.

## Adversarial review

Verdict: CLEAN within this change's scope. Reviewed filtering before all ranker branches, canonical enrichment failure, invalid/out-of-range analysis, old saved selections and links, empty retune behavior, and account exclusions. No fallback reintroduces removed candidates. Existing empty-retune behavior retains the currently playing queue with its notice. The audio engine is unchanged.

Residual limitation: arousal is an acoustic intensity constraint, not proof of subjective mood suitability. One audited account had only one calm candidate. More analyzed catalog coverage is needed; stricter filters alone cannot create variety. Baseline/hybrid completion comparisons are observational, not a causal result. No claim of independent listening or physical-phone acceptance is made for this release.

## Release boundary

Only frontend and the two backend runtime services are in scope. The frontend uses the verified Linux production output on the existing runtime image with an identical package lockfile. Backend images replace only recommendation engine and mood-policy modules. No schema migration or experiment-setting change. Exact prior image IDs and compose overlays are preserved in `/srv/music/soundspan-releases/mood-policy-20260920`; deployment guards reject concurrent image changes and retain rollback instructions. No git push.

Production verification: all three services healthy, runtime module hashes match, 12 neighboring containers preserved. Public `/health` and `/vibe` return HTTP 200. Chrome on production shows exactly three mood choices. Frontend build ID: `cd5cd086-718e-4491-b17c-f94b2ab75bee`. Post-release diagnostic queues for dartum contain 15/15 measured calm tracks (mean arousal 0.166) and 20/20 measured energetic tracks (0.881), all within their eligibility bounds. Production experiment configuration verified as active / 50%. This diagnostic check did not start playback or fabricate listening history.
