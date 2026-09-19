# Cold stream lookup: 6 September 2026

Released revision `3fe6a2c4a3664ce516b7d178549a303df9f70d33`, image
`local/soundspan-ytmusic-streamer:cold-3fe6a2c`.

Music lookup skips HLS on its first attempt. Missing formats or an explicitly
combined video rendition retain one full lookup inside the existing paced
worker. Challenges are not retried. LOSSLESS and the full-file HLS fallback
remain unchanged. No quality selector or concurrency limit changed.

verify: regression failed before implementation; final sidecar suite 538 passed,
1430 warnings; targeted suite 125 passed. Ruff lint/format passed. Mypy passed in
the dependency-equipped container with a writable temporary cache. Earlier
missing-dependency and read-only-cache failures are not passing gates.

verify: same-track isolated production-server comparison, alternating order:

| Video | Baseline resolve ms | Candidate resolve ms | Baseline prefix ms | Candidate prefix ms |
|---|---:|---:|---:|---:|
| Ve1LNJEIKUE | 3054 | 3108 | 857 | 636 |
| _e7bqZGPyFI | 2482 | 1972 | 540 | 618 |
| kXYiU_JCYtU | 2954 | 2378 | 587 | 585 |

All six returned HTTP 206 and 16384 bytes, identical Opus/webm and per-track
bitrates. No live cache deletion. The earlier probe stopped at redirects and
returned zero bytes; only the later prefix probe proves media transfer.

verify: image build passed; released runtime healthy. Deployment asserted
unchanged frontend/backend/worker container IDs. Only YT changed. No git push.
Rollback image is retained in
`/srv/music/soundspan-releases/b0-b340a7c/compose-before-cold-3fe6a2c.json`.

verify: browser Numb result `5qZQEq_C3vc` reached playing at 4319 ms and advanced
4.97 seconds without a media error, then was paused. Startup included stalled
before recovery. This different source is not a matched latency comparison.

Self-adversarial review checked bounded fallback, challenge propagation, cache,
video fallback and LOSSLESS invariants. HLS-only tracks can pay an extra lookup.
No 100-listener or physical iPhone acceptance follows from these checks.

Evidence: `output/cold-manifest-final-suite.log`,
`output/cold-manifest-mypy-clean.log`, `output/cold-manifest-prefix-canary.log`,
`output/cold-manifest-release.log`, `output/cold-browser-acceptance.log`.

P0 cold startup stays open. This removes unused work, but URL resolution and
CDN delivery still take seconds; seamless cold playback is not established.
