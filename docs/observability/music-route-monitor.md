# Public music route monitor

The operator monitor checks the public HTTPS route from the Docker host. It fetches a five-song YouTube radio and reads two consecutive 256 KiB audio ranges of a configured seed. A healthy result requires actual partial audio responses, complete bodies, exact offsets, and a consistent total length. It follows no redirects, writes no Play/history/exposure records, and stores no user credentials. Its requests can populate normal provider caches.

## Runtime and configuration

Install `scripts/music_route_monitor.py` and `scripts/music-route-runtime.cjs` together in `/opt/music-stack/music-route-monitor/`, owned by root and not writable by other users. The host requires Python 3.11+, Docker CLI, and systemd. The running Compose `backend` container supplies Node 24, compiled backend modules, Prisma and the existing configuration. Ambiguous or missing backend containers fail closed. Backend images without `isTestAccount` support cannot run the probe.

Create a dedicated operator account with `role=user`, `isTestAccount=true`, no password and no scheduled deletion, using Prisma. Use its ID in the root-owned mode-0600 configuration at `/root/.config/music-stack/music-route-monitor.json`:

```json
{
    "origin": "https://music.example.org",
    "test_user_id": "REPLACE_WITH_TEST_ACCOUNT_ID",
    "seed_video_ids": ["REPLACE_ID1", "REPLACE_ID2"],
    "compose_project": "soundspan-split-production",
    "interval_seconds": 900,
    "timeout_seconds": 60
}
```

Replace the seed placeholders with one to three verified, unrestricted music video IDs (11 characters). The monitor rotates them between runs. The default cadence is fifteen minutes after the previous service completes, plus up to one minute of randomized delay. The timer checks after boot and does not replay missed runs. Repeated manual starts still enforce a minimum of fifteen minutes between probes. The timeout applies to public HTTP calls; each socket read has a maximum five-second inactivity timeout. The entire systemd service is limited to 120 seconds. Maximum consumed audio is 512 KiB per run; radio JSON is limited to 1 MiB. The source may spool more audio internally as it does for a regular stream request.

The Node adapter mints an HS256 access JWT lasting two minutes only for the configured active, ordinary test account. The JWT exists only in captured subprocess output and HTTP headers; the backend signing key remains in the container. Backend-container discovery uses both Compose project and service labels, so recreation does not require a fixed container ID.

## Installation and operation

Install the `.service` and `.timer` files from `scripts/deploy/` in `/etc/systemd/system/`. Validate them with `systemd-analyze verify` before starting. Run one service check, then enable the timer:

```bash
systemctl daemon-reload
systemctl start soundspan-music-route-monitor.service
journalctl -u soundspan-music-route-monitor.service -n 10 --no-pager
systemctl enable --now soundspan-music-route-monitor.timer
systemctl list-timers soundspan-music-route-monitor.timer
```

The JSON journal records `ok`, `failure`, `cooldown`, `already_running`, or `monitor_error`. A probe failure records only a fixed category or HTTP status, never a response body or token. An operator/config/state error fails the service and requires attention in the journal; it does not masquerade as a healthy route.

State resides in `/var/lib/soundspan-music-route-monitor/state.json`, private to root, atomically replaced and fsynced. An exclusive file lock prevents concurrent ticks. Preserve this directory across updates. Corrupt state or a changed target/configuration fails closed: stop the timer, inspect and archive the previous state, then explicitly reset it for the changed configuration. Resetting state also resets incident/cadence tracking.

## Incidents and delivery

Three failed runs open one incident. Further failures do not create repeated notifications. Two successful runs close it and create one recovery notification. A failed run interrupts the recovery streak. Notifications go to active, non-test administrators through Soundspan's existing notification service. There is no Telegram/email delivery in this monitor.

Events are persisted before delivery. Delivery failures stay queued and are retried on later scheduled ticks, in order. The adapter checks existing notification metadata before creating each administrator notification, so retries after a partial delivery or process crash reuse the same incident/event ID. This deduplication assumes one monitor installation and the provided host lock; it is not a distributed notification queue.

If the backend/database is unavailable, journal/state record the incident and delivery waits until the backend recovers. Read admin notifications in Soundspan and inspect `notificationFailed`/`pending` in the journal for delivery problems.

## Boundaries and rollback

The check proves discovery and 512 KiB of audio transport through the public proxy. It can be satisfied by provider caches and does not prove every source, every recommended song, decoding/playback on a phone, uninterrupted background playback, the rest of a full song, or external internet access from other networks. It does not invalidate caches or disable providers to manufacture a cold-path test. A same-host monitor cannot report a complete host outage while that host is down. External host monitoring is a separate operation.

For rollback, disable and stop `soundspan-music-route-monitor.timer`, then stop its service. Preserve the private state/configuration and restore the previous scripts/units if applicable. No application restart, database migration, player change, DNS/egress change or music-library restore is required. The dedicated test account may be kept for later operator checks.

## Verification

```bash
python3 -m unittest discover -s scripts/tests -p test_music_route_monitor.py
node --test scripts/tests/music-route-runtime.test.cjs
```

Tests use a real local HTTP fixture for radio, byte ranges, truncation, redirects, and trickling body/headers. A Linux wall-clock timer interrupts the complete HTTP phase, including DNS/TLS/headers; per-read guards also bound inactivity. State lifecycle tests cover outage/recovery thresholds and failed delivery across restarts. Adapter tests isolate Prisma and signing boundaries to cover eligibility, administrator filtering and idempotent/partial notification delivery. Linux tests additionally exercise the wall-clock deadline and exclusive process lock. A live installation additionally requires a public-path check and unchanged Play/exposure counts for its test account.
