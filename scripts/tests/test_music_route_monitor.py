"""Behavioral coverage for the public probe and durable incident lifecycle."""

import importlib.util
import json
import os
import signal
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from dataclasses import replace
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from unittest.mock import Mock, patch

MODULE_PATH = Path(__file__).resolve().parents[1] / "music_route_monitor.py"
spec = importlib.util.spec_from_file_location("music_route_monitor", MODULE_PATH)
monitor = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = monitor
spec.loader.exec_module(monitor)


class PublicProbeTests(unittest.TestCase):
    def setUp(self):
        self.requests = []
        self.behavior = "healthy"
        case = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass

            def do_GET(self):
                case.requests.append(
                    (self.path, self.headers.get("Range"), self.headers.get("Authorization"))
                )
                if case.behavior == "trickle_headers":
                    try:
                        for value in b"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 2\r\n\r\n{}":
                            self.wfile.write(bytes([value]))
                            self.wfile.flush()
                            time.sleep(0.01)
                    except OSError:
                        pass
                    return
                if case.behavior == "redirect":
                    self.send_response(302)
                    self.send_header("Location", "/leaked-token")
                    self.end_headers()
                    return
                if self.path.startswith("/api/library/radio?"):
                    payload = {
                        "tracks": []
                        if case.behavior == "empty_radio"
                        else [{"youtubeVideoId": "abcdefghijk"}]
                    }
                    body = json.dumps(payload).encode()
                    self.send_response(200)
                    self.send_header("Content-Type", "application/json")
                    self.send_header("Content-Length", str(len(body)))
                    self.end_headers()
                    if case.behavior == "trickle":
                        try:
                            for value in body:
                                self.wfile.write(bytes([value]))
                                self.wfile.flush()
                                time.sleep(0.02)
                        except OSError:
                            pass
                    else:
                        self.wfile.write(body)
                    return
                start, end = map(int, self.headers["Range"].removeprefix("bytes=").split("-"))
                body = b"a" * (end - start + 1)
                self.send_response(200 if case.behavior == "ignored_range" else 206)
                self.send_header(
                    "Content-Type", "text/html" if case.behavior == "html" else "audio/mp4"
                )
                offset = start + 1 if case.behavior == "wrong_offset" else start
                total = 999999 if case.behavior == "changed_total" and start else 1000000
                self.send_header("Content-Range", f"bytes {offset}-{end}/{total}")
                if case.behavior == "broken_chunked" and start:
                    self.send_header("Transfer-Encoding", "chunked")
                else:
                    self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                if case.behavior == "broken_chunked" and start:
                    self.wfile.write(b"3\r\nabc\r\n4\r\nx")
                else:
                    self.wfile.write(body[:10] if case.behavior == "truncated" and start else body)
                self.close_connection = True

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.config = monitor.Config.from_dict(
            {
                "origin": f"http://127.0.0.1:{self.server.server_port}",
                "test_user_id": "test-user",
                "seed_video_ids": ["abcdefghijk"],
                "compose_project": "soundspan-split-production",
            },
            allow_loopback_http=True,
        )

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join()

    def test_reads_radio_and_two_consecutive_ranges_without_history_requests(self):
        result = monitor.probe(self.config, "secret-token", "abcdefghijk")
        self.assertEqual(result["bytesRead"], 524288)
        self.assertEqual(
            [item[1] for item in self.requests], [None, "bytes=0-262143", "bytes=262144-524287"]
        )
        self.assertTrue(all(item[2] == "Bearer secret-token" for item in self.requests))
        self.assertEqual(len(self.requests), 3)

    def test_rejects_short_continuation_and_invalid_audio_responses(self):
        for behavior in [
            "truncated",
            "wrong_offset",
            "changed_total",
            "html",
            "ignored_range",
            "empty_radio",
            "broken_chunked",
        ]:
            with self.subTest(behavior=behavior):
                self.behavior = behavior
                with self.assertRaises(monitor.ProbeFailure):
                    monitor.probe(self.config, "secret-token", "abcdefghijk")

    def test_never_follows_a_redirect_with_the_token(self):
        self.behavior = "redirect"
        with self.assertRaises(monitor.ProbeFailure) as failure:
            monitor.probe(self.config, "secret-token", "abcdefghijk")
        self.assertEqual(failure.exception.code, "http_302")
        self.assertEqual(len(self.requests), 1)

    def test_trickling_response_cannot_reset_the_overall_deadline(self):
        self.behavior = "trickle"
        started = time.monotonic()
        with self.assertRaises(monitor.ProbeFailure) as failure:
            monitor.probe(replace(self.config, timeout_seconds=0.05), "secret-token", "abcdefghijk")
        self.assertEqual(failure.exception.code, "timeout")
        self.assertLess(time.monotonic() - started, 1)

    @unittest.skipUnless(hasattr(signal, "setitimer"), "Linux wall-clock deadline")
    def test_trickling_headers_are_interrupted_by_the_wall_clock_deadline(self):
        self.behavior = "trickle_headers"
        started = time.monotonic()
        with self.assertRaises(monitor.ProbeFailure) as failure:
            monitor.probe(replace(self.config, timeout_seconds=0.05), "secret-token", "abcdefghijk")
        self.assertEqual(failure.exception.code, "timeout")
        self.assertLess(time.monotonic() - started, 0.3)


class IncidentTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.path = Path(self.temp.name) / "state.json"
        self.config = monitor.Config.from_dict(
            {
                "origin": "https://music.example.org",
                "test_user_id": "test-user",
                "seed_video_ids": ["abcdefghijk"],
                "compose_project": "music",
            }
        )
        self.adapter = Mock()
        self.adapter.token.return_value = "never-log-this"
        self.probe = Mock(side_effect=monitor.ProbeFailure("audio_body"))
        self.now = 100000

    def tearDown(self):
        self.temp.cleanup()

    def tick(self):
        value = monitor.tick(self.config, self.path, self.adapter, self.now, self.probe)
        self.now += self.config.interval_seconds
        return value

    def test_single_failure_does_not_notify_and_rapid_runs_do_not_probe(self):
        self.tick()
        self.adapter.notify.assert_not_called()
        monitor.tick(self.config, self.path, self.adapter, self.now - 899, self.probe)
        self.assertEqual(self.probe.call_count, 1)

    def test_persistent_incident_notifies_once_and_recovers_after_two_successes(self):
        self.tick()
        self.tick()
        self.tick()
        self.assertEqual(self.adapter.notify.call_count, 1)
        outage = self.adapter.notify.call_args.args[0]
        self.tick()
        self.assertEqual(self.adapter.notify.call_count, 1)
        self.probe.side_effect = None
        self.probe.return_value = {"bytesRead": 524288}
        self.tick()
        self.assertEqual(self.adapter.notify.call_count, 1)
        self.tick()
        self.assertEqual(self.adapter.notify.call_count, 2)
        recovery = self.adapter.notify.call_args.args[0]
        self.assertEqual(recovery["incidentId"], outage["incidentId"])
        self.assertEqual(recovery["kind"], "recovery")
        self.assertIsNone(json.loads(self.path.read_text())["incident_id"])
        self.assertNotIn("never-log-this", self.path.read_text())

    def test_failed_notification_remains_pending_across_restarts(self):
        self.adapter.notify.side_effect = RuntimeError("secret-detail")
        for _ in range(3):
            self.tick()
        state = json.loads(self.path.read_text())
        self.assertEqual(len(state["pending"]), 1)
        incident = state["pending"][0]["incidentId"]
        self.adapter.notify.side_effect = None
        self.tick()
        self.assertEqual(self.adapter.notify.call_args.args[0]["incidentId"], incident)
        self.assertEqual(json.loads(self.path.read_text())["pending"], [])

    def test_authentication_failure_is_aggregated_without_token_or_exception_details(self):
        self.adapter.token.side_effect = monitor.ProbeFailure("runtime_auth")
        for _ in range(3):
            result = self.tick()
        self.probe.assert_not_called()
        self.assertEqual(result["code"], "runtime_auth")
        self.assertEqual(self.adapter.notify.call_count, 1)

    def test_failed_outage_delivery_is_retried_before_recovery(self):
        self.adapter.notify.side_effect = RuntimeError("db temporarily down")
        for _ in range(3):
            self.tick()
        self.probe.side_effect = None
        self.probe.return_value = {}
        self.tick()
        self.tick()
        self.assertEqual(
            [event["kind"] for event in json.loads(self.path.read_text())["pending"]],
            ["outage", "recovery"],
        )
        self.adapter.notify.side_effect = None
        self.adapter.notify.reset_mock()
        self.tick()
        self.assertEqual(
            [call.args[0]["kind"] for call in self.adapter.notify.call_args_list],
            ["outage", "recovery"],
        )

    def test_corrupt_or_different_target_state_is_not_silently_reset(self):
        self.path.write_text("not json")
        with self.assertRaises(ValueError):
            self.tick()
        self.path.unlink()
        self.tick()
        changed = monitor.Config.from_dict(
            {
                "origin": "https://other.example.org",
                "test_user_id": "test-user",
                "seed_video_ids": ["abcdefghijk"],
                "compose_project": "music",
            }
        )
        with self.assertRaises(ValueError):
            monitor.tick(changed, self.path, self.adapter, self.now, self.probe)
        self.adapter.notify.assert_not_called()

    def test_operator_configuration_rejects_unsafe_targets_and_excessive_cadence(self):
        raw = {
            "origin": "https://music.example.org",
            "test_user_id": "test-user",
            "seed_video_ids": ["abcdefghijk"],
            "compose_project": "music",
        }
        for changes in [
            {"origin": "http://music.example.org"},
            {"origin": "https://user:pass@music.example.org"},
            {"origin": "https://music.example.org/path"},
            {"seed_video_ids": ["bad"]},
            {"interval_seconds": 1},
            {"timeout_seconds": 500},
        ]:
            with self.subTest(changes=changes), self.assertRaises(ValueError):
                monitor.Config.from_dict({**raw, **changes})


class RuntimeAdapterTests(unittest.TestCase):
    def test_only_marked_json_is_used_and_token_never_enters_arguments(self):
        discover = subprocess.CompletedProcess([], 0, "abcdef123456\n", "")
        reply = subprocess.CompletedProcess(
            [], 0, 'ordinary log\nSOUNDSPAN_MONITOR:{"token":"ephemeral-secret"}\n', ""
        )
        with patch.object(monitor.subprocess, "run", side_effect=[discover, reply]) as run:
            adapter = monitor.RuntimeAdapter("music")
            self.assertEqual(adapter.token("test-user"), "ephemeral-secret")
            self.assertNotIn("ephemeral-secret", str(run.call_args_list))
            self.assertEqual(json.loads(run.call_args.kwargs["input"]), {"userId": "test-user"})

    def test_ambiguous_backend_or_failed_child_is_a_safe_failure(self):
        for result in [
            subprocess.CompletedProcess([], 0, "abcdef123456\nabcdef654321\n", ""),
            subprocess.CalledProcessError(1, ["docker"], output="secret", stderr="secret"),
        ]:
            with (
                self.subTest(result=type(result).__name__),
                patch.object(monitor.subprocess, "run", side_effect=[result]),
            ):
                with self.assertRaises(monitor.ProbeFailure) as failure:
                    monitor.RuntimeAdapter("music").token("test-user")
                self.assertNotIn("secret", str(failure.exception))

    @unittest.skipUnless(os.name == "posix", "Linux operator lock")
    def test_an_existing_lock_prevents_a_second_tick(self):
        import fcntl

        with tempfile.TemporaryDirectory() as directory:
            config = Path(directory) / "config.json"
            state = Path(directory) / "state.json"
            config.write_text(
                json.dumps(
                    {
                        "origin": "https://music.example.org",
                        "test_user_id": "test-user",
                        "seed_video_ids": ["abcdefghijk"],
                        "compose_project": "music",
                    }
                )
            )
            config.chmod(0o600)
            with state.with_suffix(".lock").open("w") as lock:
                fcntl.flock(lock, fcntl.LOCK_EX)
                # Only the current interpreter and this test's private paths.
                result = subprocess.run(  # noqa: S603
                    [
                        sys.executable,
                        str(MODULE_PATH),
                        "--config",
                        str(config),
                        "--state",
                        str(state),
                    ],
                    capture_output=True,
                    text=True,
                    timeout=3,
                    check=True,
                )
            self.assertEqual(json.loads(result.stdout)["status"], "already_running")
            self.assertFalse(state.exists())


if __name__ == "__main__":
    unittest.main()
