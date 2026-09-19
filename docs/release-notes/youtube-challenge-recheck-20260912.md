# YouTube challenge recheck — 12 September 2026

## Outcome and scope

verify: an active bot challenge was not reproduced. Three uncached music recordings
were delivered completely through the production sidecar. The packaged PO-token
provider generated a token and delivered decodable audio in an isolated process.
The production recovery function also delivered the originally reported track
after an explicitly synthetic initial challenge. This establishes a functioning
recovery path, not removal of a natural YouTube IP/session restriction.

No runtime source, dependency, deployment configuration or credentials were changed.
The investigation does not establish the cause of the separate phone-stop report.

## Upstream comparison

- [yt-dlp PO Token Guide](https://github.com/yt-dlp/yt-dlp/wiki/PO-Token-Guide)
  recommends `mweb` with a PO-token provider. This is the existing recovery strategy.
- [bgutil 2.0.0](https://github.com/Brainicism/bgutil-ytdlp-pot-provider/releases/tag/2.0.0)
  is already packaged. Its [README](https://github.com/Brainicism/bgutil-ytdlp-pot-provider)
  explicitly does not guarantee that tokens resolve bot checks or HTTP 403.
- [Lavalink youtube-source](https://github.com/lavalink-devs/youtube-source)
  uses multiple InnerTube clients and supports OAuth/PO tokens. Its documentation
  also describes bot challenges and limitations. It is not an independent catalog
  or an evidenced cure for a YouTube-side restriction; no migration was made.
- [yt-dlp-getpot-wpc](https://github.com/coletdjnz/yt-dlp-getpot-wpc) is a maintained,
  experimental browser-based token-provider alternative. It requires Chrome or
  Chromium. It was reviewed, not installed or accepted in production. A controlled
  comparison is appropriate if bgutil fails under a reproducible natural challenge.
- [youtube-trusted-session-generator](https://github.com/iv-org/youtube-trusted-session-generator)
  is marked deprecated by its owner, so was not selected.
- The latest stable release inspected was [2026.08.19](https://github.com/yt-dlp/yt-dlp/releases/tag/2026.08.19),
  already installed. The inspected [nightly 2026.08.30.232658](https://github.com/yt-dlp/yt-dlp-nightly-builds/releases/tag/2026.08.30.232658)
  changelog did not list a YouTube extractor fix; no unmotivated upgrade was made.

## Runtime and fresh audio evidence

verify: production image `local/soundspan-ytmusic:challenge-20260911`, image ID
`sha256:7abcfb6f48345685fe9f7a7a11df5759bb2c1a210f9b17deb3035eb30c0c5af7`;
yt-dlp `2026.8.19`, EJS `0.8.0`, Deno `2.9.5`, ytmusicapi `1.12.2`.
The bgutil plugin is copied into the image rather than installed as a distribution;
the runtime availability check returned true. Its 2.0.0 companion was healthy,
shared the streamer's network namespace and had no published ports.
Extraction spacing remained 10–15 seconds, with two extraction workers.
SHA-256 of the three inspected recovery/context/stream source files matched the
local checkout exactly.

verify: the preceding 24-hour streamer log contained zero matching bot-challenge
entries. It contained 96 age-verification and 76 unavailable-video log lines;
these are log-line counts, not distinct user incidents. They do not establish a
CAPTCHA failure. Absence of matching log lines is not an availability guarantee.

verify: ordinary `/proxy` requests, sequential, no cache file before each request:

| Recording | Video ID | Audio bytes | Duration, seconds | First 64 KiB, seconds | Full response, seconds |
| --- | --- | ---: | ---: | ---: | ---: |
| Queen — Bohemian Rhapsody | `fJ9rUzIMcZQ` | 5,956,710 | 359.461 | 3.37 | 6.28 |
| Luis Fonsi — Despacito | `kJQP7kiw5Fk` | 4,605,080 | 281.521 | 6.93 | 9.37 |
| OneRepublic — Counting Stars | `hT_nvWreIhg` | 4,539,302 | 283.061 | 7.63 | 8.54 |

All returned HTTP 200 `audio/webm`; ffprobe identified Opus audio and the stated
duration/size. These are complete HTTP transfers, not real-time phone playback or
a concurrency benchmark. Test download copies were temporary; normal managed
production spool entries were retained.

verify: isolated `mweb` probe with the exact packaged `token_options` requested a
PO token from bgutil 2.0.0 and fully decoded `jNQXAC9IVRw`: 252,182 bytes, 19 seconds
of Opus, 14.72 seconds elapsed; no token failure, bot challenge or 403 observed.

verify: a separate ephemeral process invoked the unchanged production
`_extract_with_po_fallback` with a deliberately injected initial `DownloadError`.
It freshly fetched `2S4g1ITf5k4` (Папин Олимпос — Пьяная): 2,561,141 bytes,
159 seconds of Opus, full ffmpeg decode successful, 14.09 seconds elapsed.
The initial refusal was synthetic; the subsequent provider requests and audio were real.
The probe had no library/account mounts, no exposed port, a 512 MiB memory limit,
one CPU limit and a bounded lifetime. No challenge was injected into live requests.

## Remaining acceptance

verify: Python 3.13 sidecar suite: 650 passed, 4 existing skips, 952 FastAPI
`on_event` deprecation warnings, 63.36 seconds. Focused recovery/pacing review:
18 tests passed; the service source compiled with `compileall`. Reviewed gates
cover one recovery attempt, cancellation, concurrent probe exclusion, cooldown,
and preservation of permanent/age/403 error classification. No executable diff
was made; a new frontend/backend build or deployment was not required.

verify: both ephemeral probes were removed automatically. The temporary probe
script was removed from the production container; both YouTube services remained
healthy with their original uptime, and the public `/api/health/ready` returned
HTTP 200 with `startupComplete=true`. No service was restarted.

A natural bot challenge is still needed to compare fallback effectiveness against
the same failed request and network context. Do not provoke it with traffic bursts
or present synthetic refusal recovery as proof of permanent CAPTCHA elimination.
Additional users can increase upstream extraction pressure, but cache reuse and
bounded pacing also affect that pressure; these probes establish no safe quota.
Browser-based WPC remains a candidate for that comparison, not an enabled fallback.

The phone incident still needs device/mode/time attribution and physical-device
verification. This investigation does not close that acceptance item.
