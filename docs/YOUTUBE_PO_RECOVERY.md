# YouTube challenge recovery

PO means Proof of Origin. A token provider is not a CAPTCHA solver and does not
guarantee recovery from a blocked IP, authentication requirement or network
outage. Cached complete audio remains playable during provider cooldown.

## Optional packaging

The ordinary sidecar image contains no token provider. An operator can package
the bgutil HTTP plugin from tag `2.0.0`, commit
`37169ee2656e08c5c2e5dc9df4c598c0cb4c88a8`, into the image's
`yt_dlp_plugins` site-packages namespace. The tested extractor is yt-dlp
`2026.08.19`; version changes require the playback tests and a bounded real
audio probe. Source and license: [bgutil provider](https://github.com/Brainicism/bgutil-ytdlp-pot-provider/tree/2.0.0).

Run the matching HTTP provider as a Compose-managed companion using
`network_mode: service:ytmusic-streamer`. Bind its process to `127.0.0.1:4416`,
publish no ports, and use no account cookies. Preserve the streamer's existing
egress proxy settings without displaying them. Use a non-root user, read-only
root, bounded tmpfs, dropped capabilities, no-new-privileges, CPU/memory/PID
limits, and `logging.driver: none`: upstream trace output can include tokens.
Recreate the companion together with its namespace-owning streamer. Removing
the optional plugin image and companion restores the ordinary deployment.

## Request behavior

- Ordinary music metadata and spool extraction disable automatic token fetching;
  their client, quality and fast preparation path are otherwise unchanged.
- A recognized `Sign in to confirm ... not a bot` DownloadError permits one
  anonymous `mweb` attempt through the loopback HTTP provider. Age restriction,
  private/removed content and a generic HTTP403 do not trigger this retry.
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
