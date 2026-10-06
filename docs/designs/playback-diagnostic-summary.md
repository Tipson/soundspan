# Playback diagnostic summary

Status: shipped

The operator report reads the existing bounded playback-diagnostics journal. It deduplicates event delivery by owner and event ID, orders events by observed time, and groups only explicit owner/run pairs. A run ID identifies an audio load, not an entire listening session. Missing correlation IDs remain separate signals.

Affected runs end as recovered, failed, or unresolved. Only a recovery signal after the latest fault proves recovery; `recovery_ready` only means preparation completed. Fatal playback-error stages prove failure. Normal pauses, track endings, and visibility changes are context. Manual reports remain separate. A further fault after recovery leaves the run unresolved unless an explicit terminal outcome follows.

The command emits aggregate counts and allowlisted source/platform/phase/error categories. It never emits identifiers, titles, raw errors, URLs, or credentials. Malformed records, conflicting duplicate IDs, read failures and resource limits mark the report partial. Empty telemetry cannot prove healthy playback or supply an all-plays success rate.

This work adds no application route, database write, phone behavior, scheduler, or network change. The public-route monitor remains a separate observation. Server logs do not prove physical-device playback.
