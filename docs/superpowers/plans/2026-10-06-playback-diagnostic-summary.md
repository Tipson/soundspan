# Playback diagnostic summary implementation plan

Goal: turn existing server-side playback events into a private, reproducible aggregate report.

Architecture: a Python 3.11 standard-library operator CLI reads only owned regular JSONL files in the diagnostic journal, bounds input, correlates owner/run pairs, and emits JSON or Markdown. No application or database changes.

Tech Stack: Python 3.11+, unittest, existing playback diagnostic contract.

Spec: [Playback diagnostic summary](../../designs/playback-diagnostic-summary.md). The owner approved stage two of the development roadmap and preservation of project context in Obsidian.

Global Constraints: no git push; no raw identifiers, titles, errors, URLs or secrets in output; no log modification; no phone/autopause changes; no success-rate denominator inferred from diagnostic-only events. Existing worktree is reused. One independent final reviewer at most.

Review Focus: delayed delivery, duplicate/conflicting IDs, outcome chronology, missing correlation, bounded and symlink-safe reads, output privacy, empty/incomplete telemetry.

- [x] Add failing behavioral tests for correlation, deduplication, terminal outcomes, privacy, bounded input and CLI output.
- [x] Implement the read-only report and CI checks; document its coverage and limits.
- [x] Run tests, formatting and project build; ordinary review and independent adversarial review.
- [x] Generate aggregate reports from the real server journal, commit locally, preserve evidence and next steps in Obsidian.

verify: 24 report tests on Linux/Python 3.11, Ruff/format/mypy strict, backend build and 24 existing diagnostic/journal tests; previous monitor's 15 Python and five Node tests pass. One independent adversarial review: CLEAN, including malformed/privacy and permutation probes.

verify: installed operator command SHA-256 matches the reviewed source; directory/script 0700, aggregates 0600. Journal file hashes unchanged during execution; all 14 container IDs/images/restart counts unchanged and healthy. Live aggregate evidence remains outside the repository; no private journal was copied. Reports cover existing telemetry only, not physical-device acceptance.
