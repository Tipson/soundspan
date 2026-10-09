"""Behavioral tests for the private diagnostic-only operator report."""

import contextlib
import hashlib
import importlib.util
import io
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path

SCRIPT = Path(__file__).resolve().parents[1] / "playback_diagnostic_summary.py"
SPEC = importlib.util.spec_from_file_location("playback_diagnostic_summary", SCRIPT)
summary = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = summary
SPEC.loader.exec_module(summary)

NOW = 1_800_000_000_000


def event(name, seconds=0, *, owner="owner-a", run="run-a", event_id=None, **fields):
    """Literal server envelope; timestamps deliberately differ from delivery order."""
    return {
        "event": f"player.{name}",
        "userId": owner,
        "eventId": event_id or f"event-{name}-{seconds}",
        "observedAtMs": NOW - 60_000 + seconds * 1000,
        "receivedAtMs": NOW,
        "fields": {
            "playbackRunId": run,
            "sourceType": "ytmusic",
            "platform": "android",
            **fields,
        },
    }


class OutcomeTests(unittest.TestCase):
    def report(self, *records):
        return summary.summarize_records(records, until_ms=NOW, hours=24)

    def test_ready_is_not_sound_and_pre_recovery_is_not_terminal(self):
        report = self.report(
            event("playback_error", stage="pre_recovery", errorCategory="network"),
            event("recovery_attempt", 1),
            event("recovery_ready", 2, enginePlaying=True, currentTimeSec=0),
        )
        self.assertEqual(report["outcomes"], {"recovered": 0, "failed": 0, "unresolved": 1})
        self.assertEqual(report["affected_runs"], 1)

    def test_explicit_terminal_failure_counts_one_run_not_each_signal(self):
        report = self.report(
            event("rebuffer", currentTimeSec=4),
            event("rebuffer_timeout", 1, currentTimeSec=4),
            event("playback_error", 2, stage="pre_recovery", errorCategory="network"),
            event("playback_error", 3, stage="fatal_after_recovery", errorCategory="network"),
        )
        self.assertEqual(report["outcomes"]["failed"], 1)
        self.assertEqual(report["issue_events"], 4)
        self.assertEqual(report["breakdown"][0]["phase"], "continuation")
        self.assertEqual(report["breakdown"][0]["error_category"], "network")

    def test_observed_time_orders_delayed_delivery(self):
        report = self.report(
            event("recovery_resumed", 10, enginePlaying=True, currentTimeSec=3),
            event("playback_error", stage="fatal", currentTimeSec=0),
        )
        self.assertEqual(report["outcomes"]["recovered"], 1)

    def test_recovered_then_new_fault_is_unresolved(self):
        report = self.report(
            event("unexpected_pause", currentTimeSec=69),
            event("recovery_resumed", 1, enginePlaying=True, currentTimeSec=69.2),
            event("rebuffer", 2, currentTimeSec=72),
        )
        self.assertEqual(report["outcomes"]["unresolved"], 1)
        self.assertEqual(report["outcomes"]["recovered"], 0)

    def test_recovery_before_issue_does_not_resolve_it(self):
        report = self.report(
            event("rebuffer_recovered", enginePlaying=True, currentTimeSec=10),
            event("rebuffer_timeout", 1, currentTimeSec=14),
        )
        self.assertEqual(report["outcomes"]["unresolved"], 1)

    def test_heartbeat_recovery_needs_advancing_clock(self):
        for recovered_position, expected in (
            (0, "unresolved"),
            (4, "unresolved"),
            (4.2, "recovered"),
        ):
            with self.subTest(position=recovered_position):
                report = self.report(
                    event("rebuffer", currentTimeSec=4),
                    event(
                        "rebuffer_recovered",
                        1,
                        enginePlaying=True,
                        currentTimeSec=recovered_position,
                    ),
                )
                self.assertEqual(report["outcomes"][expected], 1)

    def test_recovery_signal_without_playing_does_not_count(self):
        report = self.report(
            event("unexpected_stop"),
            event("recovery_resumed", 1, enginePlaying=False, currentTimeSec=8),
        )
        self.assertEqual(report["outcomes"]["unresolved"], 1)

    def test_normal_context_and_manual_report_are_not_automatic_failures(self):
        report = self.report(
            event("engine_pause"),
            event("track_end", 1),
            event("visibility_change", 2),
            event("user_report", 3, reason="wrong_version"),
        )
        self.assertEqual(report["affected_runs"], 0)
        self.assertEqual(report["manual_reports"], {"wrong_version": 1})
        self.assertEqual(report["unique_events_in_window"], 4)

    def test_duplicate_delivery_is_removed_per_owner(self):
        first = event("playback_error", stage="fatal", event_id="shared-id")
        report = self.report(
            first,
            dict(first),
            event("playback_error", owner="owner-b", stage="fatal", event_id="shared-id"),
        )
        self.assertEqual(report["affected_runs"], 2)
        self.assertEqual(report["quality"]["duplicate_records_removed"], 1)
        self.assertEqual(report["unique_events_in_window"], 2)

    def test_conflicting_duplicate_id_is_quarantined(self):
        report = self.report(
            event("playback_error", event_id="conflict", stage="fatal"),
            event("recovery_resumed", 1, event_id="conflict", enginePlaying=True, currentTimeSec=9),
        )
        self.assertEqual(report["quality"]["status"], "partial")
        self.assertEqual(report["quality"]["conflicting_event_ids"], 1)
        self.assertEqual(report["affected_runs"], 0)

    def test_redelivery_with_a_new_server_receipt_time_is_still_one_event(self):
        first = event("playback_error", stage="fatal")
        redelivered = {**first, "receivedAtMs": NOW + 5000}
        report = self.report(first, redelivered)
        self.assertEqual(report["quality"]["duplicate_records_removed"], 1)
        self.assertEqual(report["quality"]["conflicting_event_ids"], 0)
        self.assertEqual(report["outcomes"]["failed"], 1)

    def test_unhashable_names_and_extreme_numeric_values_are_rejected(self):
        invalid_name = {**event("rebuffer"), "event": ["player.rebuffer"]}
        invalid_time = {**event("rebuffer"), "observedAtMs": 10**1000}
        report = self.report(invalid_name, invalid_time)
        self.assertEqual(report["quality"]["rejected_records"], 2)

    def test_missing_ids_are_not_guessed_from_load_or_song(self):
        report = self.report(
            event("playback_error", run=None, loadId=1, stage="fatal", reportTrackId="song-a"),
            event("recovery_resumed", 1, run=None, loadId=1, enginePlaying=True, currentTimeSec=9),
        )
        self.assertEqual(report["affected_runs"], 0)
        self.assertEqual(report["unlinked_issue_events"], 1)

    def test_window_does_not_borrow_a_later_recovery(self):
        report = self.report(
            event("rebuffer"),
            event("recovery_resumed", 61, enginePlaying=True, currentTimeSec=9),
            event("playback_error", -90_000, run="old", stage="fatal"),
        )
        self.assertEqual(report["outcomes"]["unresolved"], 1)
        self.assertEqual(report["quality"]["outside_window"], 2)

    def test_private_or_arbitrary_strings_never_reach_either_format(self):
        marker = "PRIVATE_USER_TITLE_URL"
        record = event(
            "playback_error",
            owner=marker,
            run=marker,
            event_id=marker,
            stage="fatal",
            sourceType=marker,
            platform=marker,
            errorCategory=marker,
            reportTitle=marker,
            reportArtist=marker,
            error=marker,
        )
        report = self.report(record)
        self.assertNotIn(marker, json.dumps(report))
        self.assertNotIn(marker, summary.render_markdown(report))
        self.assertEqual(report["breakdown"][0]["source"], "unknown")

    def test_engine_sources_remain_distinct(self):
        report = self.report(
            event("rebuffer", sourceType="audius", run="audius-run"),
            event("rebuffer", 1, sourceType="peer", run="peer-run"),
        )
        self.assertEqual([row["source"] for row in report["breakdown"]], ["audius", "peer"])

    def test_invalid_timestamps_and_events_are_rejected(self):
        record = event("playback_error", stage="fatal")
        record["observedAtMs"] = float("nan")
        report = self.report(record, event("INJECTED"), {"event": "player.rebuffer"})
        self.assertEqual(report["quality"]["rejected_records"], 3)
        self.assertEqual(report["quality"]["status"], "partial")

    def test_empty_journal_does_not_claim_health_or_a_success_rate(self):
        report = self.report()
        self.assertEqual(report["affected_runs"], 0)
        self.assertEqual(report["coverage"]["earliest_available_event_utc"], None)
        self.assertNotIn("success_rate", report)
        self.assertIn("не доказывает", summary.render_markdown(report))


class JournalTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.directory = Path(self.temp.name)

    def write(self, body, suffix="aaaaaaaaaaaaaaaa"):
        path = self.directory / f"incident-1800000000000-{suffix}.jsonl"
        path.write_text(body, encoding="utf-8")
        return path

    def test_reader_handles_truncated_tail_and_ignores_unowned_files(self):
        self.write(json.dumps(event("playback_error", stage="fatal")) + '\n{"event":')
        (self.directory / "credentials.jsonl").write_text("PRIVATE", encoding="utf-8")
        report = summary.generate_report(self.directory, until_ms=NOW, hours=24)
        self.assertEqual(report["outcomes"]["failed"], 1)
        self.assertEqual(report["quality"]["rejected_records"], 1)
        self.assertEqual(report["quality"]["status"], "partial")
        self.assertEqual(report["quality"]["files_read"], 1)

    def test_reader_bounds_bytes_and_rejects_oversized_lines(self):
        self.write("x" * 10_000 + "\n" + json.dumps(event("rebuffer")) + "\n")
        report = summary.generate_report(self.directory, until_ms=NOW, hours=24)
        self.assertEqual(report["affected_runs"], 1)
        self.assertEqual(report["quality"]["rejected_records"], 1)
        bounded = summary.generate_report(self.directory, until_ms=NOW, hours=24, max_bytes=100)
        self.assertEqual(bounded["quality"]["status"], "partial")
        self.assertGreater(bounded["quality"]["limits_reached"], 0)

    def test_record_limit_is_explicit(self):
        self.write("\n".join(json.dumps(event("rebuffer", n)) for n in range(3)) + "\n")
        report = summary.generate_report(self.directory, until_ms=NOW, hours=24, max_records=1)
        self.assertEqual(report["quality"]["limits_reached"], 1)
        self.assertEqual(report["unique_events_in_window"], 1)

    @unittest.skipIf(os.name == "nt", "Symlink creation may need Windows privilege")
    def test_owned_symlink_is_never_followed(self):
        outside = self.directory / "outside"
        outside.write_text(json.dumps(event("playback_error", stage="fatal")), encoding="utf-8")
        (self.directory / "incident-1800000000000-bbbbbbbbbbbbbbbb.jsonl").symlink_to(outside)
        report = summary.generate_report(self.directory, until_ms=NOW, hours=24)
        self.assertEqual(report["affected_runs"], 0)
        self.assertEqual(report["quality"]["read_errors"], 1)

    def test_cli_outputs_aggregates_and_leaves_source_unchanged(self):
        source = self.write(json.dumps(event("playback_error", stage="fatal")) + "\n")
        before = hashlib.sha256(source.read_bytes()).hexdigest()
        output = io.StringIO()
        with contextlib.redirect_stdout(output):
            exit_code = summary.main(
                ["--journal-dir", str(self.directory), "--until-ms", str(NOW), "--format", "json"]
            )
        self.assertEqual(exit_code, 0)
        self.assertEqual(json.loads(output.getvalue())["outcomes"]["failed"], 1)
        self.assertEqual(hashlib.sha256(source.read_bytes()).hexdigest(), before)

    def test_cli_fails_closed_on_missing_directory(self):
        output = io.StringIO()
        with contextlib.redirect_stderr(output):
            result = summary.main(["--journal-dir", str(self.directory / "PRIVATE_PATH")])
        self.assertEqual(result, 2)
        self.assertNotIn("PRIVATE_PATH", output.getvalue())


if __name__ == "__main__":
    unittest.main()
