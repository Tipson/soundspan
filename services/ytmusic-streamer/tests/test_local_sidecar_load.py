"""Integration coverage for the deterministic local sidecar workload."""

from __future__ import annotations

import importlib.util
from pathlib import Path
from types import ModuleType
from typing import Any

import pytest

REPOSITORY_ROOT = Path(__file__).resolve().parents[3]
HARNESS_PATH = REPOSITORY_ROOT / "scripts" / "ytmusic-sidecar-load.py"


def _load_harness() -> ModuleType:
    spec = importlib.util.spec_from_file_location("ytmusic_sidecar_load", HARNESS_PATH)
    if spec is None or spec.loader is None:
        raise AssertionError("Unable to load the sidecar workload module")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_default_stages_include_target_and_one_higher_stage() -> None:
    harness = _load_harness()

    assert harness.DEFAULT_STAGES[:3] == (20, 50, 100)
    assert harness.DEFAULT_STAGES[-1] > 100


@pytest.mark.anyio
async def test_local_tcp_workload_exercises_real_sidecar_boundaries(tmp_path: Path) -> None:
    harness = _load_harness()

    report: dict[str, Any] = await harness.run_sidecar_workload(
        stages=(12,),
        spool_directory=tmp_path,
    )

    assert report["mode"] == "local-sidecar-deterministic-upstream"
    assert report["providerNetworkRequests"] == 0
    assert report["acceptance"] == {"passed": True, "issues": []}
    assert report["measurementDefinitions"]["audibleMs"]["measured"] is False
    assert "browser" in report["measurementDefinitions"]["audibleMs"]["reason"].lower()
    transports = report["transportProfiles"]
    assert transports["freshTcpFanout"]["keepAliveEnabled"] is False
    keepalive = transports["perListenerKeepAlive"]
    assert keepalive["listeners"] == 12
    assert keepalive["endpoint"] == "/search"
    assert keepalive["firstWave"]["successes"] == 12
    assert keepalive["immediateReuseWave"]["successes"] == 12
    assert keepalive["afterServerIdleWave"]["successes"] == 12
    assert keepalive["firstWaveUpstreamCalls"] == 1
    assert keepalive["immediateReuseConnections"] == 12
    assert keepalive["reconnectedAfterServerIdle"] == 12

    stage = report["stages"][0]
    assert stage["listeners"] == 12

    stream = stage["stream"]
    assert stream["sameTrackCold"]["successes"] == 12
    assert stream["sameTrackCold"]["upstreamCalls"] == 1
    assert stream["sameTrackCold"]["peakActiveStreamLeases"] == 12
    assert stream["sameTrackCold"]["peakPendingJobs"] == 1
    assert stream["sameTrackCold"]["peakProviderWorkers"] == 1
    assert stream["warmDistinct"]["successes"] == 12
    assert stream["warmDistinct"]["failures"] == 0
    assert stream["coldDistinct"]["errors"]["capacity"] == 4
    assert stream["rapidSkip"]["cancelled"] == 12
    assert stream["rapidSkip"]["final"]["successes"] == 12
    assert stream["faults"]["unavailable"]["errors"] == {"unavailable": 12}
    assert stream["faults"]["unavailable"]["upstreamCalls"] == 1
    assert stream["faults"]["unavailable"]["joinedWaitersAtRelease"] == 12
    assert stream["faults"]["unavailable"]["cooldownReplay"]["error"] == "unavailable"
    assert stream["faults"]["timeout"]["errors"] == {"timeout": 12}
    assert stream["faults"]["timeout"]["upstreamCalls"] == 1
    assert stream["faults"]["timeout"]["joinedWaitersAtRelease"] == 12
    assert stream["faults"]["timeout"]["cooldownReplay"]["error"] == "timeout"

    search = stage["search"]
    assert search["sameQueryCold"]["successes"] == 12
    assert search["sameQueryCold"]["upstreamCalls"] == 1
    assert search["sameQueryWarm"]["successes"] == 12
    assert search["sameQueryWarm"]["upstreamCalls"] == 0
    assert search["batchSameQuery"]["rows"] == 12
    assert search["batchSameQuery"]["upstreamCalls"] == 1
    assert set(search["mixedCachedCold"]["errors"]) == {"capacity"}
    assert search["mixedCachedCold"]["failures"] > 0

    tail = stage["tail"]
    assert tail["generationReplaced"] is True
    assert tail["finalStatuses"] == {"complete": 48}
    assert tail["runtime"]["owners"] <= tail["bounds"]["ownerCapacity"]
    assert tail["runtime"]["jobs"] <= tail["bounds"]["capacity"]
    assert tail["peakActiveJobs"] <= tail["bounds"]["concurrency"]
    assert tail["peakUpstreamWork"] <= tail["bounds"]["providerConcurrency"]

    bounds = report["observedBounds"]
    assert bounds["streamProviderPeak"] <= bounds["streamProviderLimit"]
    assert bounds["streamTransferPeak"] <= bounds["streamTransferLimit"]
    assert bounds["searchProviderPeak"] <= bounds["searchProviderLimit"]
    assert bounds["maxSpoolPending"] <= bounds["spoolPendingLimit"]
    assert bounds["maxTailJobs"] <= bounds["tailCapacity"]
    assert bounds["searchCacheEntries"] <= bounds["searchCacheLimit"]
    assert bounds["maxSearchCacheEntries"] <= bounds["searchCacheLimit"]
    assert bounds["maxRetainedSpoolBytes"] <= bounds["spoolByteLimit"]
    assert 0 < bounds["maxSpoolReservedBytes"] <= bounds["spoolByteLimit"]
    assert bounds["spoolFailureCacheEntries"] <= bounds["spoolFailureCacheLimit"]
    assert bounds["maxSpoolFailureCacheEntries"] <= bounds["spoolFailureCacheLimit"]
