# Hybrid Recommendations and Canonical Audio Analysis

Soundspan Hybrid v2 is the single recommendation policy boundary used by Home,
My Wave, Made For You, and Similar Tracks. It combines playable provider
candidates, account-scoped listening signals, shared canonical audio features,
and a deterministic diversity pass. A missing optional provider or missing
embedding degrades quality; it does not make the queue unavailable.

## Request Flow

```text
authenticated surface
  -> provider candidate adapters (YouTube Music, optional ListenBrainz)
  -> canonical identity (MBID -> ISRC -> fingerprint -> metadata/duration)
  -> account-scoped history, dislikes, taste centroids and recent exposures
  -> shared DCLAP/Essentia features + bounded DCLAP text-mood vector when available
  -> ranker v2, canonical dedupe, cooldown, MMR and artist/album caps
  -> playable queue + generationId + degradedSources
```

Each surface exposes only the rows it actually renders. Candidate acquisition
keeps a bounded reserve of up to 25 rows per source lane, while the ranker first
uses candidates outside the one/seven-day cooldown and only then performs a
deterministic recent-history backfill under the same dislike, playability,
canonical-dedupe, artist, album, and lane caps. This lets a Home render be
recorded accurately without exhausting the next Wave request.

`backend/src/services/recommendations/recommendationService.ts` is the public
service facade. Candidate acquisition remains replaceable, while canonical
identity, ranking, experiment semantics, exposure persistence, and hot-set
admission stay behind the same module boundary.

The authenticated endpoints are:

- `GET /api/personalized/home` for Home, Wave, and Made For You;
- `GET /api/player/related` for online-first similar tracks and related
  artist/album rows.

Similar Tracks always attempts the playable YouTube Music radio fallback. A
canonical DCLAP seed augments ranking when available, but it is not required
for a non-empty response.

## Engine Modes

Set `RECOMMENDATION_ENGINE_MODE` to one of:

| Mode | Served result | Persisted comparison |
| --- | --- | --- |
| `baseline` | baseline-v1 | baseline only |
| `shadow` | baseline-v1 | the same candidate batch is also ranked and stored as non-served hybrid-v2 |
| `active` | hybrid-v2 | active hybrid generation |

`shadow` is the application default and the safe production rollout mode.
Do not switch to `active` merely because the build is healthy. Promotion needs
enough paired live generations and a measurable quality win without an
unacceptable latency or provider-failure regression.

The read-only evaluator accepts either a rolling window or explicit UTC dates:

```bash
npm --prefix backend run recommendations:evaluate-shadow -- --hours 24
npm --prefix backend run recommendations:evaluate-shadow -- \
  --since 2026-09-01T00:00:00Z --until 2026-09-08T00:00:00Z
```

Its JSON report compares baseline and hybrid playability, meaningful
completion, early skips, one/seven-day repeats, artist coverage/diversity,
mean/p95 latency, and paired Jaccard overlap. An empty report means more live
traffic is needed; it is not evidence for activation.

Prometheus exposes:

- `soundspan_recommendation_generations_total`;
- `soundspan_recommendation_generation_seconds`;
- `soundspan_recommendation_degraded_sources_total`;
- `soundspan_recommendation_exposures_total`;
- `soundspan_recommendation_playback_outcomes_total`.

Labels are intentionally bounded to surface, known algorithm, delivery state,
and known playback outcome. User, track, provider ID, and error text are never
metric labels.

## Canonical Feature Store

`CanonicalRecording` owns global identity and scalar Essentia/MusiCNN features.
`canonical_recording_embeddings` owns one 512-dimensional vector per canonical
recording and registered embedding space. `TrackMapping` links provider
identities to that shared row. The shared analysis contains no account taste or
history.

`RecommendationGeneration` and `RecommendationExposure` are account-scoped.
They retain the served/shadow algorithm, session and surface, ordered canonical
exposures, source attribution, latency, and later playback outcome. Cross-session
repeat cooldowns therefore survive browser reloads without reading another
account's signals. A technical playback failure is recorded for playability
measurement and is never converted into dislike affinity.

For Calm, Energetic, Focus, and Workout, the ranker can compare canonical DCLAP
audio vectors with a validated text vector from the active embedding space.
Those four process-local vectors are single-flight cached. One 750 ms total
deadline and a five-minute negative cache make provider absence a scalar-feature
fallback rather than a Wave failure. Favorites and Forgotten remain preference
intents and do not manufacture an acoustic text target.

## Optional ListenBrainz Adapter

For a connected account, the adapter can add ListenBrainz collaborative-filter
recording MBIDs and LB Radio tag candidates, then resolves them to playable
provider rows. The complete optional branch has one six-second deadline in
addition to per-request timeouts, is cached, and is protected by a circuit
breaker. Last-good reads and writes have their own 250 ms ceiling. Playable
resolution is limited to two global sidecar calls, carries an `AbortSignal` into
Axios, and disables transport retries, so an expired optional branch cannot
continue filling the shared YouTube Music socket pool. Partial resolution keeps
successful candidates and records a degraded source. No ListenBrainz token is
required for baseline YouTube Music fallback, and an outage cannot stop My Wave.

## Remote Hot-Set Analysis

Remote analysis is opt-in and never blocks an HTTP recommendation request.
Enable it only when the backend worker and audio analyzer share a writable
`/music` volume:

```dotenv
REMOTE_ANALYSIS_ENABLED=true
REMOTE_ANALYSIS_DAILY_BUDGET=100
REMOTE_ANALYSIS_CONCURRENCY=1
```

The bounded flow is:

1. Up to twelve top candidates from a generation are deduplicated by canonical
   recording and admitted to the Bull hot-set queue.
2. A Redis Lua reservation enforces one global per-recording decision and the
   configured UTC daily budget atomically across worker replicas.
3. The worker streams at most 64 MiB into a unique direct child of
   `/music/.soundspan-analysis-spool` and creates an `AnalysisAssetLease`. A
   partial unique index permits only one active lease per canonical recording,
   closing the scheduler/worker race across replicas. The complete download has
   an absolute fifteen-minute deadline propagated as an `AbortSignal` through
   provider proxying and the Node stream pipeline; expiry destroys the response
   stream and cannot strand a worker indefinitely.
4. DCLAP writes the vector when available. Scalar and embedding completion have
   independent status/version/error timestamps, so a temporary DCLAP failure
   remains retryable after Essentia succeeds. An embedding-only retry does not
   repeat already-completed scalar analysis.
5. The worker commits `queued_essentia` on `AnalysisAssetLease`; this PostgreSQL
   row is the durable hand-off, so a rolling deployment never exposes a new
   payload to an older destructive Redis consumer.
6. One audio-analyzer replica atomically claims the lease, writes canonical
   scalar features transactionally, and removes only its owned hidden-spool
   file after persistence settles. Every completion/failure/retry transition is
   fenced by `status=processing` and an unexpired lease; a late worker cannot
   overwrite recovery state.
7. Retryable work releases the consumed asset for a fresh download. Terminal
   failures and a single-flight startup-plus-periodic TTL recovery remove stale
   temporary assets. A timed-out running ProcessPool is terminated (and killed
   if necessary) before its lease is released or file is removed. Cleanup
   failures remain retryable every fifteen minutes. Remote audio is not retained
   as a library track. Disabling remote-analysis admission does not disable this
   recovery loop, so assets created before a flag change still expire.

`AUDIO_ANALYSIS_ENABLED=false` disables the processor as well as the analyzer
path. Lite mode forces remote analysis off because it does not run both analysis
services.

## Activation Gate

Before changing production to `active`:

1. collect a representative shadow window across Home, Wave, Made For You, and
   Similar Tracks;
2. verify no account-scope or provider-playability regression;
3. require lower one/seven-day repeat rates and no worse early-skip rate;
4. require a useful completion/diversity improvement with acceptable p95
   latency;
5. change only `RECOMMENDATION_ENGINE_MODE`, then monitor the same report and
   Prometheus counters.

Gorse remains a future candidate adapter/ranker experiment. It is not required
by Hybrid v2 and must pass the same shadow gate before serving users.
