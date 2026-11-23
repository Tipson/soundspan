# YouTube challenge recovery

PO means Proof of Origin. A token provider is not a CAPTCHA solver and does not
guarantee recovery from a blocked IP, authentication requirement or network
outage. Cached complete audio remains playable during provider cooldown.

## Optional packaging

The ordinary sidecar image contains no token provider. An operator can package
the bgutil HTTP plugin from tag `2.0.2`, commit
`26475e9d3665b972c4aeb83b4dbaafcf64b88438`, into the image's
`yt_dlp_plugins` site-packages namespace. The provider gate also accepts the
legacy `2.0.0` plugin. Pair yt-dlp `2026.10.26` with its required EJS `0.8.0`
package and a supported Deno runtime. Version changes require the playback
tests and a bounded real audio probe. Source and license:
[bgutil provider](https://github.com/Brainicism/bgutil-ytdlp-pot-provider/tree/2.0.2).

Run the matching HTTP provider as a Compose-managed companion using
`network_mode: service:ytmusic-streamer`. Bind its process to `127.0.0.1:4416`,
publish no ports, and use no account cookies. Preserve the streamer's existing
egress proxy settings without displaying them. Use a non-root user, read-only
root, bounded tmpfs, dropped capabilities, no-new-privileges, CPU/memory/PID
limits, and `logging.driver: none`: upstream trace output can include tokens.
Recreate the companion together with its namespace-owning streamer. Removing
the optional plugin image and companion restores the ordinary deployment.

## Request behavior

- Provider refusal opens a shared pause, starting at 90 seconds and doubling
  after subsequent failed windows up to 15 minutes. Concurrent failures reuse
  the current deadline. Fresh successful extraction resets older failures;
  cached audio and an older in-flight success cannot clear a newer refusal.
- Paced requests recheck the pause after waiting, including format fallback
  and token recovery. Queued work cannot continue contacting the provider on
  an admission decision made before another worker's refusal.
- Set extraction spacing and concurrency conservatively for sustained public
  traffic. Millisecond spacing validated in a short throughput test is not a
  long-term provider quota or an availability guarantee.

- Ordinary music metadata and spool extraction disable automatic token fetching;
  their client, quality and fast preparation path are otherwise unchanged.
- A recognized `Sign in to confirm ... not a bot` DownloadError permits one
  anonymous `mweb` attempt through the loopback HTTP provider. Age restriction,
  private/removed content and a generic HTTP403 do not trigger this retry.
- This token attempt enables Deno/EJS without changing the primary client's
  runtime options. Token generation and format extraction do not prove that
  the selected CDN can deliver audio bytes.
- The attempt retains format/size selectors, cancellation hooks and the caller's
  worker slot/deadline. Its internal downloader retries are zero. Existing
  format-table retries surround neither the probe nor another probe.
- Only one probe runs per sidecar process. Other challenges receive HTTP503 with
  a short Retry-After; a failed probe cools down for90 seconds. It cannot create
  a second thread pool or recursively skip the remaining queue.
- A timed-out/cancelled metadata caller cannot start a late probe. Cancellation
  during a blocking socket operation still relies on its bounded timeout; Python
  cannot safely kill a running thread.
- Fallback logging records only the attempted/recovered video ID. Raw token
  messages and signed URLs are not forwarded from the plugin.

## Verification boundary

Unit/runtime tests inject the challenge to verify control flow. A successful
anonymous full-audio download verifies provider compatibility and bytes, but
does not verify recovery of an actual YouTube challenge. Record that outcome
separately when a natural challenge occurs; do not provoke repeated blocks.

Reference: [yt-dlp PO Token Guide](https://github.com/yt-dlp/yt-dlp/wiki/PO-Token-Guide).
