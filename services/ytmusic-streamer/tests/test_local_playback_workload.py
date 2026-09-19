"""Playback-shaped loopback workload with long-lived HTTP media responses."""

from __future__ import annotations

import asyncio
import importlib.util
import json
import subprocess
import sys
from pathlib import Path
from typing import Any

import pytest

REPOSITORY_ROOT = Path(__file__).resolve().parents[3]
WORKLOAD_PATH = REPOSITORY_ROOT / "scripts" / "ytmusic-playback-workload.py"


@pytest.mark.anyio
async def test_playback_workload_accepts_two_hundred_listener_stage() -> None:
    spec = importlib.util.spec_from_file_location("playback_workload_limit_test", WORKLOAD_PATH)
    assert spec is not None and spec.loader is not None
    workload = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(workload)

    with pytest.raises(ValueError, match="timings must be non-negative"):
        await workload.run_playback_workload(listeners=200, cold_stagger_ms=-1)


def test_listener_timeout_covers_full_two_hundred_listener_ramp() -> None:
    spec = importlib.util.spec_from_file_location("playback_workload_timeout_test", WORKLOAD_PATH)
    assert spec is not None and spec.loader is not None
    workload = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(workload)

    assert workload._listener_request_timeout_seconds(200, 275.0, 5000.0) >= 75.0


@pytest.mark.parametrize("status_code", [200, 206])
@pytest.mark.anyio
async def test_playback_egress_probe_can_release_a_browser_decodable_prefix(
    status_code: int,
) -> None:
    spec = importlib.util.spec_from_file_location("playback_workload_probe_test", WORKLOAD_PATH)
    assert spec is not None and spec.loader is not None
    workload = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(workload)
    sent: list[dict[str, Any]] = []

    async def app(_scope: Any, _receive: Any, send: Any) -> None:
        await send({"type": "http.response.start", "status": status_code, "headers": []})
        await send({"type": "http.response.body", "body": b"abcdef", "more_body": False})

    async def capture(message: dict[str, Any]) -> None:
        sent.append(message)

    probe = workload._PlaybackEgressProbe(app, first_chunk_bytes=3)
    generation = probe.begin(["browser0001"])
    task = asyncio.create_task(
        probe(
            {"type": "http", "path": "/proxy/browser0001"},
            lambda: None,
            capture,
        )
    )
    await asyncio.wait_for(generation.changed.wait(), timeout=1)

    assert sent[1]["body"] == b"abc"
    assert sent[1]["more_body"] is True
    generation.release.set()
    await task
    assert sent[2]["body"] == b"def"
    assert sent[2]["more_body"] is False


def test_playback_workload_holds_distinct_streams_and_measures_fanout(tmp_path: Path) -> None:
    report_path = tmp_path / "playback-workload.json"
    completed = subprocess.run(  # noqa: S603 -- fixed interpreter and repository script
        [
            sys.executable,
            str(WORKLOAD_PATH),
            "--listeners",
            "12",
            "--cold-stagger-ms",
            "275",
            "--hold-ms",
            "50",
            "--output",
            str(report_path),
        ],
        cwd=REPOSITORY_ROOT,
        capture_output=True,
        text=True,
        timeout=45,
        check=False,
    )

    assert report_path.exists(), completed.stdout + completed.stderr
    report = json.loads(report_path.read_text(encoding="utf-8"))
    assert report["mode"] == "local-sidecar-playback-transport"
    assert report["providerNetworkRequests"] == 0
    acceptance = report["acceptance"]
    assert acceptance["transportCapacityPassed"] is True
    assert acceptance["transportCapacityIssues"] == []
    assert acceptance["preparedLatencyTargetMs"] == 500.0
    assert acceptance["overallPassed"] is acceptance["preparedLatencyMet"]
    assert completed.returncode == (0 if acceptance["overallPassed"] else 2)
    assert report["measurementDefinitions"]["browserAudible"]["measured"] is False

    cold = report["coldStaggeredDistinct"]
    assert cold["listeners"] == 12
    assert cold["http"]["successes"] == 12
    assert cold["peakActivePlaybackStreams"] == 12
    assert cold["upstreamResolveCalls"] == 12
    assert cold["upstreamTransferCalls"] == 12
    assert cold["peakPendingJobs"] <= cold["pendingLimit"]

    warm = report["warmConcurrentDistinct"]
    assert warm["http"]["successes"] == 12
    assert warm["peakActivePlaybackStreams"] == 12
    assert warm["playbackUpstreamResolveCalls"] == 0
    assert warm["playbackUpstreamTransferCalls"] == 0
    assert warm["serverTiming"]["scheduledToAsgiMs"]["samples"] == 12
    assert warm["serverTiming"]["asgiToHeadersMs"]["samples"] == 12
    assert warm["serverTiming"]["headersToFirstBodyMs"]["samples"] == 12
    assert warm["filesystemLookup"]["calls"] >= 12

    rapid = report["rapidSkipPrepared"]
    assert rapid["cancelled"] == 12
    assert rapid["next"]["successes"] == 12
    assert rapid["peakActiveNextStreams"] == 12
    assert rapid["upstreamResolveCalls"] == 0
    assert rapid["upstreamTransferCalls"] == 0
