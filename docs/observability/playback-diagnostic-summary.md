# Playback diagnostic report

`scripts/playback_diagnostic_summary.py` is a read-only Python 3.11+ command for the existing backend `logs/playback-diagnostics` journal. It uses the standard library, does not require credentials or a database connection, and emits aggregate JSON or Russian Markdown to stdout. The command does not send notifications or schedule itself.

## Run

Find the backend's `/app/logs` volume mount using the deployment's container configuration. Use its `playback-diagnostics` subdirectory; do not scan the whole logs directory, copy private journals into the repository, or include arbitrary service logs. The split deployment's named volume normally lives under Docker's data directory. The operator needs read access to the private journal, usually root.

```sh
python3 scripts/playback_diagnostic_summary.py \
  --journal-dir /path/to/backend/logs/playback-diagnostics \
  --hours 24 --format markdown

python3 scripts/playback_diagnostic_summary.py \
  --journal-dir /path/to/backend/logs/playback-diagnostics \
  --hours 168 --format json
```

`--hours` accepts 1–168 hours and defaults to 24. `--until-ms` optionally fixes the inclusive window end as Unix milliseconds for reproducible comparisons; the default is execution time. All output timestamps are UTC. Redirect only aggregate output to a private file if needed (`umask 077`).

Exit codes: `0` means input processing completed, `1` means an aggregate was produced from partial/conflicting input, `2` means no report could be produced. An empty report or exit zero is **not** a playback health verdict.

## Interpretation

- Deduplication uses `(userId, eventId)`. A repeated server receipt timestamp is ignored when the observed timestamp exists. Copies with conflicting event contents are quarantined and mark the report partial. Legacy records without event IDs deduplicate only exact copies.
- Correlation uses `(userId, playbackRunId)`. A run is an audio load, not a listening session or a unique track. Runs of different owners remain separate. Missing IDs are never guessed from track IDs, load counters, or nearby times; unlinked fault signals are counted separately.
- Events are ordered by client observation time; server receipt time is a fallback only for records without observation time. The outcome includes events inside the selected window alone. A recovery outside it cannot resolve an inside-window issue.
- Fault signals are unexpected stop/pause, rebuffer, rebuffer timeout and playback error. Multiple signals in one run count as one affected run. Normal pause, track end and visibility are context; user reports are separate reason counts.
- **Recovered:** an advancing `recovery_resumed` signal with the engine playing, or a later `rebuffer_recovered` whose playing clock advanced beyond the latest fault position. Zero/reset or unchanged clocks do not establish heartbeat recovery. `recovery_attempt` and `recovery_ready` never establish recovery.
- **Failed:** an explicit `playback_error` at `fatal` or `fatal_after_recovery`, without a later proven recovery. Later nonterminal signals do not erase that failure.
- **Unresolved:** fault signals without either terminal evidence. A new fault after recovery reopens this outcome. This is not automatically an outage: the listener may have stopped, changed tracks, or gone offline before another event arrived.

Breakdown rows use the first fault's source/platform/phase and the last known fault error category. Phase is `startup` for clock zero, `continuation` for positive clock, and `unknown` if absent. The category describes a client signal, not an established root cause. Source is the engine's requested source; an orchestrator fallback's final provider may differ. Hourly frequency counts each run once at its first fault in the selected window. Raw signal counts remain available in JSON.

## Privacy and coverage

Only fixed source/platform/phase/error/event/reason labels and counts appear in output. User IDs, run IDs, event IDs, song names, raw errors, URLs and credentials remain absent. Unknown labels become `unknown`; they cannot become output keys or Markdown content.

The journal contains queued client diagnostics, not every play or every API failure. Legacy console-only events and generic `Playback.Trace`/`Playback.Metric` copies are not ingested. Do not derive a success percentage or combine provider/API faults with client runs without a shared correlation ID. The [public-route monitor](music-route-monitor.md) observes radio and transport separately. Neither report proves playback on a physical phone.

The backend retains at most eight 4 MiB journal files for up to seven days; rotation can shorten the available history. The report shows the actual earliest/latest available observations, not a guarantee of continuous coverage for its requested window. Late client delivery can change an earlier report, so comparisons should use a fixed `--until-ms` and the same journal snapshot when exact reproducibility matters.

Reads are bounded to 64 owned files, 4,096 directory entries, 64 MiB and 100,000 records. Each line is limited to 8,192 bytes; oversized lines are discarded in bounded chunks. Only regular files with the journal's owned filename format are read, with symlinks and inode replacement rejected. Malformed JSON, invalid envelopes, conflicts, read errors and reached limits mark processing `partial`; output still contains valid remaining aggregates. The command never deletes or repairs journal files.

Removing the operator script rolls back this feature. It has no application image, scheduler, database or journal migration to undo.

## Verify

```sh
python3 -m unittest discover -s scripts/tests -p test_playback_diagnostic_summary.py
```

The operator CI runs these tests on Linux/Python 3.11, including symlink rejection. Local Windows runs can skip that filesystem-specific case.
