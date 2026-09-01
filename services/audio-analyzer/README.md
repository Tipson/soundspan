# Audio Analyzer

The audio analyzer consumes local track jobs and persists MusicCNN/Essentia
features, EBU R128 loudness, and Chromaprint fingerprints.

Fingerprinting uses the image-provided `fpcalc` binary. It is silently optional
at runtime: a missing binary logs one warning and does not fail track analysis.
Every computed fingerprint is stored before any external lookup, so later
AcoustID passes do not decode audio again.

Canonical remote-analysis work is handed off through durable
`AnalysisAssetLease` rows in PostgreSQL. Each analyzer polls a bounded batch and
atomically changes one `queued_essentia` lease to `processing`; competing
replicas skip the row and never touch the winning worker's file. Legacy
canonical Redis payloads remain readable during rolling upgrades, but the
backend does not produce new ones.

Canonical jobs persist scalar features on `CanonicalRecording` instead of a
local `Track`. Cleanup is deliberately fail-closed: `deleteAfter` is honored
only for a direct child of `.soundspan-analysis-spool`; absolute paths,
traversal, backslashes, nested library paths, and any other reference are
retained and the lease is marked `cleanup_failed`. Retryable analysis releases
the temporary asset and obtains a fresh bounded download on the next admission.
The backend's periodically enforced expiring asset lease remains the recovery
authority.

`canonical_analysis.py` owns the fenced PostgreSQL lease lifecycle and global
canonical feature persistence. `analysis_worker_runtime.py` owns bounded mixed
local/canonical queue processing and force-terminates a timed-out process pool
before a lease is released or its temporary asset can be removed. Keeping these
two boundaries separate prevents late children from publishing results after
recovery has reassigned the work.

`remote_audio_decode.py` owns the system-FFmpeg boundary for the exact generated
`.soundspan-analysis-spool/<uuid>.audio` form. It content-probes the neutral
asset name, emits bounded mono float32 PCM, discards decoder stderr, and returns
safe failures to canonical persistence and cleanup without first invoking
Essentia's codec runtime. Ordinary library paths continue to use MonoLoader.

Set `ACOUSTID_API_KEY` to enable claim-based AcoustID lookups. The worker limits
requests to three per second, uses bounded timeouts and retries, and stores a
MusicBrainz recording and release-group identity only at score `0.70` or higher.
Without a key, lookup stays disabled and local fingerprint computation continues.

Run the CI-equivalent unit suite from the repository root:

```bash
pytest services/audio-analyzer/tests -q
```

Remote hot-set configuration and the shadow activation gate are documented in
[`../../docs/HYBRID_RECOMMENDATIONS.md`](../../docs/HYBRID_RECOMMENDATIONS.md).
