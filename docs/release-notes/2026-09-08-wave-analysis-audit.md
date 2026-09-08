# Wave analysis audit

Baseline: `b17ecef3`. This report separates measurements from rollout decisions.

## Findings and corrections

- At the audit snapshot, 2,109 canonical recordings had scalar analysis and 2,100 had active embeddings. In 24 hours, 486 scalar analyses and 474 embeddings completed. The pipeline is processing work, not stuck for a week. Dartum's 344 saved provider records resolve to 263 distinct canonical recordings: 160 analyzed, 102 pending, one failed.
- The remote analyzer scored the first 90 seconds. On the same full Short Change Hero audio file and production model, the intro scored instrumentalness 0.897; the central excerpt scored 0.035 through the corrected decoder. A long intro can misclassify a vocal song. Remote decoding selects the central bounded excerpt, with a bounded prefix fallback when duration cannot be read. Whole-file fingerprinting remains unchanged. DCLAP is not changed by this scalar fix.
- An unexpected feature-extraction exception could return partial features without `_error`, allowing false completion. It now returns an explicit failure.
- RMS energy saturates at 1 on 1,066 of 2,109 recordings. Mood ranking already prefers model arousal, so this audit does not rescale historical energy arbitrarily. Speechiness is a derived vocal proxy, not an independent speech classifier; it must not become a strong rap/content exclusion signal.
- Focus gave instrumentalness more weight than intensity. Its feature score is now 50% low arousal, 35% instrumentalness and 15% low danceability. Gentle vocals can outrank aggressive instrumental music.
- Catalog scoring treated missing skip measurements as early dislikes and penalized nearly completed skipped tracks. It now uses the shared early-skip predicate, keeps late/unmeasured skips neutral, and recognizes near-completion. The recent served-Wave sample contained no missing skip measurements; this is a proven edge-case fix, not the cause of every reported recommendation issue.
- Authenticated diagnostic home/Wave requests compute normally but do not persist recommendation generations, viewed impressions, analysis admission or recommendation metrics. Likes, account settings and unrelated endpoints are not implicitly sandboxed. Existing personal histories are not rewritten.

## Hybrid decision

Keep the implementation and the 50% session rollout; do not delete it or expand to 100% on the available evidence. It actually reranks personal candidates using active DCLAP vectors and session/context history. It is not a separate unlimited music catalog.

Served-Wave, within-account seven-day observations show heterogeneous results:

| Account    | Baseline measured / completed / early skips | Hybrid measured / completed / early skips |
| ---------- | ------------------------------------------- | ----------------------------------------- |
| Dartum     | 292 / 126 / 126                             | 321 / 284 / 29                            |
| Someclade  | 167 / 78 / 60                               | 77 / 37 / 21                              |
| agentik007 | 243 / 185 / 43                              | 62 / 15 / 36                              |
| Laurisoul  | 191 / 122 / 66                              | No comparable sample                      |

These are observational counts, not causal uplift. Previous releases, user-selected settings and historic diagnostic listening confound comparison. Do not pool accounts into a single claimed success percentage.

## Same-input queue replay

The replay uses real captured candidates, vectors, exposures, time, 36 total / 12 per-lane limits, engine-level recent exclusions, and the actual frontend shelf interleaver. First 12 queue items:

| Account    | Focus mean arousal before → after | Changed positions |
| ---------- | --------------------------------- | ----------------- |
| Dartum     | 0.467 → 0.467                     | 2                 |
| Laurisoul  | 0.593 → 0.558                     | 5                 |
| agentik007 | 0.696 → 0.674                     | 3                 |

Neutral ordering is unchanged. Calm versus energetic differs for Laurisoul (0.551 / 0.670) and agentik007 (0.684 / 0.797), but Dartum's available measured candidates still produce the same first-12 mean. Mood quality is therefore not closed by the formula alone: candidate coverage and personal candidate supply remain limiting.

## Verification and release boundary

- verify: backend build exit 0; 33 targeted suites, 389 tests passed.
- verify: audio-analyzer suites 217 passed, 13 skipped (unconfigured PostgreSQL integration fixtures); changed Python Ruff checks passed.
- verify: isolated production-model image, central decoder, full local audio: Enhanced mode with nine model heads, instrumentalness 0.035, arousal 0.370; 25.54 seconds analysis. No network or production DB connection in the model probe.
- API, backend worker and audio-analyzer images only; no frontend, YouTube streamer, DCLAP, schema or authentication changes.
- Release requires a fresh compose backup, exact running-image guards, health checks and frontend-to-API smoke. Preserve prior images for rollback. Existing analysis is not bulk invalidated.

## Remaining work

- Repair the confirmed stale scalar result through the fenced canonical-analysis pipeline; measure useful coverage growth after rollout.
- Audit explicit saved-music signals in Hybrid and broaden useful personalized mood candidates; validate discoveries, repeats and multiple-account behavior.
- Validate one challenge-only PO fallback and staged load separately. A successful no-challenge download does not prove CAPTCHA recovery.
- AI direction: a text music request mapped into validated listening intent and existing personal ranking, not invented track titles or a paid service enabled without agreement.

## Risk review

One self-contained adversarial pass, no additional agents. Scope: authenticated diagnostic isolation, decoder containment/deadlines, partial-failure handling, compatible ranking, release rollback. No unresolved P0/P1 found in this package. Remaining risks: a center excerpt is still a sample, old prefix analyses persist until targeted reanalysis, and captured-pool checks do not replace listening acceptance or load tests.
