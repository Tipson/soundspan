# [1.6.1] Release Notes - 2026-07-08

A fast-follow patch release for 1.6.0. It fixes a settings-save bug that could silently wipe stored service credentials (most visibly the admin TIDAL connection), makes the "Skip" download-fallback setting actually skip, stops library scans from getting the background worker killed, and fixes "Remove from playlist". Small release, but if you run 1.6.0 you want it — see **Before you upgrade** for one intentional behavior change.

## Your credentials stop disappearing

Saving system settings could quietly overwrite stored secrets with empty values: the settings form round-trips every field, so any Save from a page that loaded a secret as empty (for example, a tab opened before you connected TIDAL) wrote that emptiness back over the real credential. This is why a freshly connected TIDAL admin account could silently "disconnect" itself.

- Secret fields (`lidarrApiKey`, `soulseekPassword`, `openaiApiKey`, and the rest) are now **write-only with explicit semantics**: a non-empty value replaces the secret, an empty string changes nothing, and `null` (API only) explicitly clears it.
- The same guard covers the `.env` sync for Docker deployments, which independently had the identical overwrite hole.
- TIDAL admin tokens got the strictest treatment: the general settings API no longer accepts **or returns** them at all. `GET /api/system-settings` reports a `tidalConnected` boolean instead of the decrypted tokens, the settings UI derives connection status from it (previously it could show "connected" with no working credentials), and the device-code flow is the only way tokens are written.
- The Soulseek connection is no longer restarted on every settings save when the password field merely round-trips empty.

## "Skip" now means skip

With a primary download source configured plus "When Primary Source Fails: Skip", an unavailable primary silently rerouted downloads to whatever other service was up — TIDAL-primary setups quietly sent albums to Lidarr. Now: Skip fails the job with a clear error ("tidal unavailable — skipped"), an explicitly configured fallback is used only when that service is actually available, and jobs fail honestly when both the primary and its fallback are down instead of grabbing a third source you didn't choose.

## Background worker stops crash-looping during scans

1.6.0's opus-duration fix made the library scanner fully parse **every** audio file to read its duration. On a large library that pegged the worker's CPU for minutes at a time — job locks were lost, scans re-queued endlessly, health probes timed out, and Kubernetes kept killing the worker (visible as "random" worker restarts). The scanner now reads durations from file headers where they live for most formats, and only pays the full-file parse for ogg/opus files (e.g. YouTube downloads), which keep their durations.

## Remove from playlist works again (#34)

Removing a track from a playlist looked like it did nothing — the delete succeeded server-side, but the page never updated its cached copy. The row now disappears immediately, the playlist refreshes in the background, and a failed removal shows an error instead of being silent.

## Before you upgrade

- **Clearing a secret by emptying its field no longer works.** That gesture was indistinguishable from the accidental-wipe bug this release fixes. To remove a credential, disable the service, or send an explicit `null` for the field via the API. Everything else about editing settings is unchanged.
- No schema migrations, no config changes. Drop-in upgrade from 1.6.0.
