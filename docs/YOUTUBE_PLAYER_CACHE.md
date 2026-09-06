# YouTube player preprocessing cache

The YouTube sidecar shares serialized EJS preprocessing of public player code
between fresh yt-dlp instances. Audio URLs, cookies, account identifiers,
challenge inputs and challenge responses are not cache entries. Every request
is evaluated independently; audio format selection is unchanged.

## Bounds and failure behavior

- At most two entries and 16 MiB of retained serialized bytes per process.
- Entries expire after one hour; LRU eviction keeps the byte budget bounded.
- The key includes the public script content and EJS version. A changed script
  cannot reuse preprocessing from another script.
- JSON decoding and Deno execution still require temporary working memory;
  the 16 MiB limit is not a limit on the complete process RSS.
- A failed cached execution is retried once using the original public script.
  The stock yt-dlp Deno provider remains available as a fallback.
- Cache state is in memory only; service restart discards it. There is no disk
  cache to clean and no schema or user-data migration.

## Compatibility

Registration is lazy and limited to yt-dlp `2026.08.19`, whose private EJS hooks
are covered by the adapter tests. The version check happens before importing
those hooks. Other versions continue with stock extraction and an informational
log message. Initialization errors are logged by exception type, without
request data, and do not prevent extraction. A dependency update requires
explicit adapter revalidation before expanding the supported version.

This optimization avoids repeated preprocessing. It does not remove the first
player download, the first preprocessing run, metadata requests, admission
queues or audio-CDN latency. Its component benchmark is not an end-to-end
playback latency guarantee or a concurrent-listener capacity result.

The behavioral tests are `test_player_preprocess_cache.py` and
`test_player_cache_bootstrap.py` under `services/ytmusic-streamer/tests`.
