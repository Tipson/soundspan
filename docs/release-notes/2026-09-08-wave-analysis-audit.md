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

- Restore reliable cold CDN delivery before accepting cold-source concurrency. New download timeouts are not neural-model failures and are not evidence of a bot challenge.
- Reduce measured recommendation-request latency under concurrency. Do not reuse cached-audio capacity as recommendation or cold-source capacity.
- Observe post-release listening outcomes separately by account and algorithm before widening Hybrid. Same-input ranking checks do not prove subjective satisfaction.
- Validate the PO branch during a naturally occurring bot challenge; a simulated first refusal followed by real audio is only a recovery-path test.
- Product proposal only: [text-controlled personal Wave](../designs/AI_WAVE_REQUESTS.md). No paid model or fabricated recommendation history was added.

## Follow-up: saved taste and effective mood supply

The scalar/diagnostic package `91c984b0` was released. API, worker and analyzer are
healthy; frontend-to-API health returned 200. Frontend, YouTube and DCLAP container
identities were unchanged. Rollback compose is
`/srv/music/soundspan-releases/b0-b340a7c/compose-before-wave-91c984b0.json`.
The one confirmed Short Change Hero recording was reprocessed by a normal fenced
lease using the already downloaded full file: completed, v4-center, arousal 0.370,
instrumentalness 0.035. Previous fields are backed up in the backend logs volume
as `wave-center-91c984b0-backup.json`. No extra YouTube download or history edit.

Further reproduced defects:

- Hybrid's positive audio profile omitted current likes unless those tracks were
  played through recommendation telemetry. Separate saved-recording centroids
  retain that preference without multiplying the ranker coefficient or generating
  synthetic listening history. Real read-only lookup: Dartum158 vectors,
  Someclade95, Laurisoul14, agentik00725; accounts without eligible likes return0.
- Pre-truncating saved candidates prevented moods from reaching suitable analyzed
  tracks outside25 entries. The bounded saved reserve does not add liked tracks
  into Discoveries or bypass final exclusions.
- Copying the same track into ten playlists could move it above an explicitly
  liked song. Collection membership now contributes once per provider song.
- The Redis budget was857 with a limit500 because denied work incremented it.
  Denials also remained cached after limit increases. The corrected Lua counts
  admissions only; real isolated Redis tests cover concurrent admission,
  idempotency, rejection and a limit increase.

Same-data first12 queue replay, after the scalar correction and before/after the
saved-profile/reserve change (canonical deduplication retains original lane
priority, exactly as the facade does):

| Account    | Calm before → after | Energetic before → after | Focus before → after |
| ---------- | ------------------- | ------------------------ | -------------------- |
| Dartum     | 0.473 → 0.288       | 0.473 → 0.756            | 0.473 → 0.318        |
| Laurisoul  | 0.551 → 0.551       | 0.670 → 0.670            | 0.558 → 0.551        |
| agentik007 | 0.684 → 0.666       | 0.797 → 0.791            | 0.674 → 0.674        |

Values are mean measured arousal, not a listening-quality score. All queues
contained12 tracks and at least11 distinct artists except Laurisoul's baseline
neutral queue. Dartum's sample still includes3 unmeasured discovery tracks;
improved analyzed coverage remains necessary. A Focus mode cannot guarantee
lyric-free quiet music when the personal catalog does not contain it.

## Risk review

One self-contained adversarial pass, no additional agents. Scope: authenticated diagnostic isolation, decoder containment/deadlines, partial-failure handling, compatible ranking, release rollback. The saved-profile follow-up also checks account filters, bounded candidate/vector reads, preservation of lane priority and Redis admission concurrency. No unresolved P0/P1 found in these changes. Remaining risks: a center excerpt is still a sample, old prefix analyses persist until targeted reanalysis, and captured-pool checks do not replace listening acceptance or load tests.

## Published packages and useful analysis growth

`dc306c09` is deployed to backend and worker. The admitted-analysis daily budget
is 750 with the same two-worker concurrency. The old Redis counter was reconciled
from 857 attempts to 500 admitted jobs using a compare-and-set guard, preserving
all admitted reservations and the previous state in
`/app/logs/wave-budget-2026-09-08-backup.json`. Denied attempts accounted for the
357 difference. Normal hot-set scheduling was requested for 12 active accounts;
there was no fabricated listening or mass reset of analysis/history.

verify: the saved-taste release passed 35 targeted backend suites / 405 tests,
including admission concurrency against isolated real Redis; backend build exit0.
Its rollback compose is
`/srv/music/soundspan-releases/b0-b340a7c/compose-before-wave-dc306c09.json`.

At 20:12 UTC, scalar completion was 2,161 versus 2,109 at the audit start; 53
completed records used v4-center, including the repaired existing recording.
At a later account lookup, Dartum had 181 completed liked canonical records.
The linked canonical population changed during enrichment, so this is not a
fixed-denominator cohort percentage. Someclade had95, Laurisoul14 and agentik00725.

The extra budget also exposed at least57 remote-analysis failures during the
release window. Streamer logs show connection/read timeouts to the audio CDN
before decoding; these are not failed model predictions. A same signed-URL
bounded byte request timed out with both 3s and 10s connection limits. Merely
raising a timeout is not a demonstrated fix. Existing Soundspan proxy/tunnel
services remained active and their routing configuration was not changed.

DCLAP uses 10s windows with 5s stride over the decoded ordinary song, with a
1,800s cap, rather than the scalar analyzer's old first-90s excerpt. Its active
embedding space was preserved; unrelated vectors were not invalidated.

## PO recovery deployment and proof boundary

`70e6720f` is deployed as `local/soundspan-ytmusic:po-70e6720f` with the pinned
bgutil2.0.0 companion on namespace-local loopback, no host port and no account
cookies. Ordinary extraction does not automatically fetch PO tokens. Only a
recognized bot challenge admits one mweb recovery attempt under the existing
worker/deadline, cancellation, serialized admission and failed-attempt cooldown.
Quality and byte limits remain intact; generic403 does not trigger this branch.

verify: 587 streamer tests passed,4 skipped; changed-module Ruff and mypy passed.
A probe injected the initial challenge, then performed real mweb extraction,
full audio retrieval and decoding: Your Woman, 3,875,453 bytes, Opus119.29kbps,
25.48s total. This is neither a naturally occurring CAPTCHA recovery nor
time-to-audible playback. The provider bootstrap warning in the probe was traced
to loading the optional provider before yt-dlp's plugin loader; the probe was
corrected without repeating a full download solely for that warning.

Rollback compose:
`/srv/music/soundspan-releases/b0-b340a7c/compose-before-po-70e6720f.json`.
Backend, worker, frontend, streamer, PO companion, analyzer and DCLAP were all
healthy in the final container check. Frontend and DCLAP were not redeployed.

## Production capacity measurements

Real HTTP requests crossed frontend proxy, backend and streamer. Four authorized
accounts were used with explicit diagnostic isolation; no play/impression writes.
The cached-audio test used20 already cached tracks and two65,536-byte ranges per
concurrent client. It is not100 distinct people, full playback or device decoding.

| Workload | Concurrent clients | Requests | Errors | p95 |
| --- | ---: | ---: | ---: | ---: |
| Cached audio | 10 | 20 | 0 | 116ms |
| Cached audio | 25 | 50 | 0 | 233ms |
| Cached audio | 50 | 100 | 0 | 460ms |
| Cached audio | 100 | 200 | 0 | 861ms |
| Recommendation generation | 10 | 20 | 0 | 5,483ms |

Recommendation escalation stopped at10 because p95 exceeded the5s stop threshold;
25/50/100 recommendation clients were not accepted. Cold audio escalation was
not started while CDN timeouts were already present. Full report:
`/app/logs/wave-load-70e6720f.json` in the backend persistent logs volume.

A real isolated facade timing sample took4,365ms: source feed2,558ms, saved mood
reserve94ms, language preparation22ms, taste context570ms, and102 individual
canonical resolutions (batched by8). Canonical call-time sum is not wall time.
An experimental parallel-context change preserved all24 returned track positions
in six alternating before/after requests, but warmed timings overlapped
(before448–484ms; after390–559ms, excluding each variant's first request).
There was no stable measured gain; this runtime change was discarded, not shipped.
The existing canonical transaction retry recovered one write conflict in the
probe; no uncaught request failure occurred. This is a profiling lead, not a
claim that concurrency capacity has been fixed.

The task-owned local Redis test container was removed after verification. No
user volumes, existing production caches or rollback images were deleted.
