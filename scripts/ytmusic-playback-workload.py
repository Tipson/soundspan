#!/usr/bin/env python3
"""Exercise long-lived listener-shaped HTTP streams against the local sidecar.

The production FastAPI routes, spool singleflight, admission, provider budget,
progressive transfer, cache, cancellation, and FileResponse paths remain real.
Only the true external YouTube/CDN calls and downstream network backpressure are
replaced with deterministic local adapters. This is not a browser-audible SLO.
"""

from __future__ import annotations

import argparse
import asyncio
import importlib
import importlib.util
import json
import logging
import os
import secrets
import sys
import tempfile
import threading
import time
from collections.abc import Callable, Sequence
from contextlib import suppress
from pathlib import Path
from types import ModuleType
from typing import Any

import httpx

_REPOSITORY_ROOT = Path(__file__).resolve().parents[1]
_BASE_HARNESS_PATH = _REPOSITORY_ROOT / "scripts" / "ytmusic-sidecar-load.py"
_INTERNAL_SECRET = secrets.token_urlsafe(24)
_QUALITY = "HIGH"


def _timing_summary(samples: Sequence[float]) -> dict[str, float | int | None]:
    ordered = sorted(samples)

    def quantile(fraction: float) -> float | None:
        if not ordered:
            return None
        position = (len(ordered) - 1) * fraction
        lower_index = int(position)
        upper_index = min(len(ordered) - 1, lower_index + 1)
        weight = position - lower_index
        value = ordered[lower_index] + (ordered[upper_index] - ordered[lower_index]) * weight
        return round(value, 3)

    return {
        "samples": len(ordered),
        "p50": quantile(0.5),
        "p95": quantile(0.95),
        "max": round(ordered[-1], 3) if ordered else None,
    }


class _FilesystemLookupProfiler:
    """Measure cache lookup plus prune-lock wait without changing its result."""

    def __init__(self, lookup: Callable[..., Any]) -> None:
        self._lookup = lookup
        self._phase = "setup"
        self._samples: dict[str, list[float]] = {}
        self._lock = threading.Lock()

    def set_phase(self, phase: str) -> None:
        with self._lock:
            self._phase = phase

    def __call__(self, *args: Any, **kwargs: Any) -> Any:
        with self._lock:
            phase = self._phase
        started = time.perf_counter()
        try:
            return self._lookup(*args, **kwargs)
        finally:
            elapsed_ms = (time.perf_counter() - started) * 1000
            with self._lock:
                self._samples.setdefault(phase, []).append(elapsed_ms)

    def summary(self, phase: str) -> dict[str, Any]:
        with self._lock:
            samples = tuple(self._samples.get(phase, ()))
        summary = _timing_summary(samples)
        summary["calls"] = len(samples)
        summary["cumulativeMs"] = round(sum(samples), 3)
        return summary


def _load_base_harness() -> ModuleType:
    spec = importlib.util.spec_from_file_location(
        "soundspan_ytmusic_sidecar_load",
        _BASE_HARNESS_PATH,
    )
    if spec is None or spec.loader is None:
        raise RuntimeError("Unable to load the deterministic sidecar harness")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class _EgressGeneration:
    """One set of responses held after their first byte by test backpressure."""

    def __init__(self, video_ids: Sequence[str]) -> None:
        self.video_ids = frozenset(video_ids)
        self.release = asyncio.Event()
        self.changed = asyncio.Event()
        self.first_byte_count = 0
        self.active = 0
        self.peak_active = 0
        self._scheduled_at: dict[str, float] = {}
        self._asgi_at: dict[str, float] = {}
        self._headers_at: dict[str, float] = {}
        self._first_body_at: dict[str, float] = {}
        self._first_body_sent_at: dict[str, float] = {}

    def scheduled(self, video_id: str) -> None:
        self._scheduled_at[video_id] = time.perf_counter()

    def entered_asgi(self, video_id: str) -> None:
        self._asgi_at[video_id] = time.perf_counter()

    def started_headers(self, video_id: str) -> None:
        self._headers_at[video_id] = time.perf_counter()

    def joined(self, video_id: str, first_body_at: float, sent_at: float) -> None:
        self.first_byte_count += 1
        self.active += 1
        self.peak_active = max(self.peak_active, self.active)
        self._first_body_at[video_id] = first_body_at
        self._first_body_sent_at[video_id] = sent_at
        self.changed.set()

    def left(self) -> None:
        self.active = max(0, self.active - 1)
        self.changed.set()

    def timing_summary(self) -> dict[str, Any]:
        def durations(
            start: dict[str, float],
            end: dict[str, float],
        ) -> dict[str, float | int | None]:
            return _timing_summary(
                [
                    (end[video_id] - started_at) * 1000
                    for video_id, started_at in start.items()
                    if video_id in end
                ]
            )

        return {
            "scheduledToAsgiMs": durations(self._scheduled_at, self._asgi_at),
            "asgiToHeadersMs": durations(self._asgi_at, self._headers_at),
            "headersToFirstBodyMs": durations(self._headers_at, self._first_body_at),
            "firstBodySendMs": durations(self._first_body_at, self._first_body_sent_at),
            "asgiToFirstBodyMs": durations(self._asgi_at, self._first_body_at),
        }


class _PlaybackEgressProbe:
    """ASGI adapter that models a slow listener after the first media byte."""

    def __init__(self, app: Any, *, first_chunk_bytes: int = 1) -> None:
        if first_chunk_bytes < 1:
            raise ValueError("first_chunk_bytes must be positive")
        self._app = app
        self._first_chunk_bytes = first_chunk_bytes
        self._generation: _EgressGeneration | None = None

    def begin(self, video_ids: Sequence[str]) -> _EgressGeneration:
        current = self._generation
        if current is not None and not current.release.is_set():
            raise RuntimeError("Prior playback egress generation is still held")
        generation = _EgressGeneration(video_ids)
        self._generation = generation
        return generation

    def release_current(self) -> None:
        if self._generation is not None:
            self._generation.release.set()

    async def __call__(self, scope: Any, receive: Any, send: Any) -> None:
        generation = self._generation
        path = str(scope.get("path", "")) if scope.get("type") == "http" else ""
        video_id = path.removeprefix("/proxy/") if path.startswith("/proxy/") else None
        if generation is None or video_id not in generation.video_ids:
            await self._app(scope, receive, send)
            return
        generation.entered_asgi(video_id)

        status_code: int | None = None
        joined = False

        async def send_with_backpressure(message: dict[str, Any]) -> None:
            nonlocal joined, status_code
            if message.get("type") == "http.response.start":
                status_code = int(message.get("status", 0))
                generation.started_headers(video_id)
            body = bytes(message.get("body", b""))
            if (
                message.get("type") == "http.response.body"
                and status_code in {200, 206}
                and body
                and not joined
            ):
                joined = True
                first = dict(message)
                first["body"] = body[: self._first_chunk_bytes]
                first["more_body"] = True
                first_body_at = time.perf_counter()
                await send(first)
                generation.joined(video_id, first_body_at, time.perf_counter())
                try:
                    await generation.release.wait()
                finally:
                    generation.left()

                remainder = body[self._first_chunk_bytes :]
                more_body = bool(message.get("more_body", False))
                if remainder or not more_body:
                    rest = dict(message)
                    rest["body"] = remainder
                    rest["more_body"] = more_body
                    await send(rest)
                return
            await send(message)

        await self._app(scope, receive, send_with_backpressure)


async def _wait_for_listeners(
    generation: _EgressGeneration,
    tasks: Sequence[asyncio.Task[dict[str, Any]]],
    expected: int,
    *,
    timeout_seconds: float = 10.0,
) -> None:
    deadline = time.monotonic() + timeout_seconds
    while generation.first_byte_count < expected:
        failures = [
            task.result() for task in tasks if task.done() and task.result().get("ok") is not True
        ]
        if failures:
            raise AssertionError(f"Playback listeners failed before first byte: {failures!r}")
        if time.monotonic() >= deadline:
            raise TimeoutError(
                "Timed out waiting for playback streams "
                f"({generation.first_byte_count}/{expected} reached first byte)"
            )
        generation.changed.clear()
        with suppress(TimeoutError):
            await asyncio.wait_for(generation.changed.wait(), timeout=0.05)


async def _new_listener_clients(base_url: str, listeners: int) -> list[httpx.AsyncClient]:
    return [
        httpx.AsyncClient(
            base_url=base_url,
            headers={"x-internal-secret": _INTERNAL_SECRET},
            timeout=httpx.Timeout(60.0),
            limits=httpx.Limits(max_connections=1, max_keepalive_connections=1),
        )
        for _ in range(listeners)
    ]


async def _preconnect_listener_clients(clients: Sequence[httpx.AsyncClient]) -> float:
    started = time.perf_counter()
    responses = await asyncio.gather(*(client.get("/health") for client in clients))
    failures = [response.status_code for response in responses if response.status_code != 200]
    if failures:
        raise AssertionError(f"Listener preconnect failed: {failures!r}")
    return (time.perf_counter() - started) * 1000


async def _sample_event_loop_lag(stop: asyncio.Event, samples: list[float]) -> None:
    interval_seconds = 0.01
    while not stop.is_set():
        expected = time.perf_counter() + interval_seconds
        await asyncio.sleep(interval_seconds)
        samples.append(max(0.0, (time.perf_counter() - expected) * 1000))


async def _run_held_wave(
    base: ModuleType,
    clients: Sequence[httpx.AsyncClient],
    upstream: Any,
    stream_module: Any,
    probe: _PlaybackEgressProbe,
    lookup_profiler: _FilesystemLookupProfiler,
    video_ids: Sequence[str],
    *,
    phase: str,
    stagger_seconds: float,
    hold_seconds: float,
) -> tuple[dict[str, Any], _EgressGeneration]:
    upstream.set_phase(phase)
    lookup_profiler.set_phase(phase)
    generation = probe.begin(video_ids)
    tasks: list[asyncio.Task[dict[str, Any]]] = []
    event_loop_lag: list[float] = []
    lag_stop = asyncio.Event()
    lag_task = asyncio.create_task(_sample_event_loop_lag(lag_stop, event_loop_lag))
    peak_pending = int(stream_module._spool_pending_jobs)
    try:
        for client, video_id in zip(clients, video_ids, strict=True):
            generation.scheduled(video_id)
            tasks.append(
                asyncio.create_task(
                    base._observe_stream(client, upstream, video_id, consume_full=True)
                )
            )
            if stagger_seconds:
                await asyncio.sleep(stagger_seconds)
            peak_pending = max(peak_pending, int(stream_module._spool_pending_jobs))

        await _wait_for_listeners(generation, tasks, len(video_ids))
        peak_pending = max(peak_pending, int(stream_module._spool_pending_jobs))
        pinned_at_hold = len(stream_module._spool_pin_counts)
        await asyncio.sleep(hold_seconds)
        generation.release.set()
        results = await asyncio.gather(*tasks)
    except BaseException:
        generation.release.set()
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
        raise
    finally:
        generation.release.set()
        lag_stop.set()
        await lag_task
    await base._wait_stream_idle(stream_module, upstream)
    cleanup_started = time.perf_counter()
    await base._wait_until(
        lambda: not stream_module._spool_pin_counts,
        "playback response pins released",
        timeout_seconds=5.0,
    )
    pin_release_wait_ms = (time.perf_counter() - cleanup_started) * 1000
    return (
        {
            "listeners": len(video_ids),
            "http": base._summarize(results),
            "peakActivePlaybackStreams": generation.peak_active,
            "peakPendingJobs": peak_pending,
            "pendingLimit": stream_module._SPOOL_MAX_PENDING_JOBS,
            "pinnedPathsWhileHeld": pinned_at_hold,
            "pinnedPathsAfterRelease": len(stream_module._spool_pin_counts),
            "pinReleaseWaitMs": base._round(pin_release_wait_ms),
            "serverTiming": generation.timing_summary(),
            "eventLoopLagMs": _timing_summary(event_loop_lag),
            "filesystemLookup": lookup_profiler.summary(phase),
            "upstreamResolveCalls": upstream.stream_call_count(phase),
            "upstreamTransferCalls": upstream.transfer_call_count(phase),
        },
        generation,
    )


async def _run_rapid_skip(
    base: ModuleType,
    current_clients: Sequence[httpx.AsyncClient],
    next_clients: Sequence[httpx.AsyncClient],
    upstream: Any,
    stream_module: Any,
    probe: _PlaybackEgressProbe,
    lookup_profiler: _FilesystemLookupProfiler,
    current_ids: Sequence[str],
    next_ids: Sequence[str],
    *,
    hold_seconds: float,
) -> dict[str, Any]:
    current_phase = "playback-rapid-current"
    upstream.set_phase(current_phase)
    lookup_profiler.set_phase(current_phase)
    current_generation = probe.begin(current_ids)
    current_tasks = []
    for client, video_id in zip(current_clients, current_ids, strict=True):
        current_generation.scheduled(video_id)
        current_tasks.append(
            asyncio.create_task(base._observe_stream(client, upstream, video_id, consume_full=True))
        )
    await _wait_for_listeners(current_generation, current_tasks, len(current_ids))
    for task in current_tasks:
        task.cancel()
    current_generation.release.set()
    current_results = await asyncio.gather(*current_tasks)
    cancelled = sum(result.get("error") == "cancelled" for result in current_results)

    next_phase = "playback-rapid-next"
    next_summary, next_generation = await _run_held_wave(
        base,
        next_clients,
        upstream,
        stream_module,
        probe,
        lookup_profiler,
        next_ids,
        phase=next_phase,
        stagger_seconds=0.0,
        hold_seconds=hold_seconds,
    )
    return {
        "listeners": len(current_ids),
        "cancelled": cancelled,
        "peakActiveCurrentStreams": current_generation.peak_active,
        "peakActiveNextStreams": next_generation.peak_active,
        "currentServerTiming": current_generation.timing_summary(),
        "currentFilesystemLookup": lookup_profiler.summary(current_phase),
        "nextServerTiming": next_summary["serverTiming"],
        "nextEventLoopLagMs": next_summary["eventLoopLagMs"],
        "nextFilesystemLookup": next_summary["filesystemLookup"],
        "next": next_summary["http"],
        "upstreamResolveCalls": upstream.stream_call_count(current_phase)
        + upstream.stream_call_count(next_phase),
        "upstreamTransferCalls": upstream.transfer_call_count(current_phase)
        + upstream.transfer_call_count(next_phase),
        "pinnedPathsAfterRelease": len(stream_module._spool_pin_counts),
    }


def _transport_capacity_issues(report: dict[str, Any]) -> list[str]:
    listeners = int(report["listeners"])
    issues: list[str] = []
    cold = report["coldStaggeredDistinct"]
    warm = report["warmConcurrentDistinct"]
    rapid = report["rapidSkipPrepared"]
    for name, wave in (("cold", cold), ("warm", warm)):
        if wave["http"]["successes"] != listeners or wave["http"]["failures"]:
            issues.append(f"{name} playback did not serve every listener")
        if wave["peakActivePlaybackStreams"] != listeners:
            issues.append(f"{name} playback did not hold every listener concurrently")
        if wave["pinnedPathsAfterRelease"]:
            issues.append(f"{name} playback leaked spool pins")
    if cold["upstreamResolveCalls"] != listeners or cold["upstreamTransferCalls"] != listeners:
        issues.append("cold distinct playback did not preserve one upstream fanout per track")
    if cold["peakPendingJobs"] > cold["pendingLimit"]:
        issues.append("cold distinct playback exceeded pending admission")
    if warm["playbackUpstreamResolveCalls"] or warm["playbackUpstreamTransferCalls"]:
        issues.append("warm distinct playback unexpectedly reached upstream")
    if rapid["cancelled"] != listeners:
        issues.append("rapid skip did not cancel every current response")
    if rapid["next"]["successes"] != listeners or rapid["next"]["failures"]:
        issues.append("rapid skip did not serve every prepared next track")
    if rapid["peakActiveNextStreams"] != listeners:
        issues.append("rapid skip did not hold every next stream concurrently")
    if rapid["upstreamResolveCalls"] or rapid["upstreamTransferCalls"]:
        issues.append("prepared rapid skip unexpectedly reached upstream")
    if rapid["pinnedPathsAfterRelease"]:
        issues.append("rapid skip leaked spool pins")
    bounds = report["observedBounds"]
    if bounds["providerPeak"] > bounds["providerLimit"]:
        issues.append("provider concurrency exceeded its runtime limit")
    if bounds["transferPeak"] > bounds["transferLimit"]:
        issues.append("progressive transfer concurrency exceeded its runtime limit")
    return issues


async def run_playback_workload(
    *,
    listeners: int = 100,
    cold_stagger_ms: float = 275.0,
    hold_ms: float = 5000.0,
    preconnect_listeners: bool = False,
    spool_directory: Path | None = None,
) -> dict[str, Any]:
    """Run cold, warm, and rapid-skip listener waves over real loopback HTTP."""
    if listeners < 1 or listeners > 120:
        raise ValueError("listeners must be between 1 and 120")
    if cold_stagger_ms < 0 or hold_ms < 0:
        raise ValueError("timings must be non-negative")

    base = _load_base_harness()
    base.__dict__["_INTERNAL_SECRET"] = _INTERNAL_SECRET
    service_root = _REPOSITORY_ROOT / "services" / "ytmusic-streamer"
    for path in (service_root, _REPOSITORY_ROOT):
        if str(path) not in sys.path:
            sys.path.insert(0, str(path))
    os.environ["INTERNAL_API_SECRET"] = _INTERNAL_SECRET

    app_module: Any = importlib.import_module("app")
    stream_module: Any = importlib.import_module("ytmusic_stream")
    temporary: tempfile.TemporaryDirectory[str] | None = None
    if spool_directory is None:
        temporary = tempfile.TemporaryDirectory(prefix="soundspan-playback-load-")
        spool_directory = Path(temporary.name)
    spool_directory.mkdir(parents=True, exist_ok=True)

    upstream = base._DeterministicUpstream(stream_module, spool_directory)
    probe = _PlaybackEgressProbe(app_module.app)
    original_stream_info_provider = stream_module._get_stream_url_sync
    original_stream_response = stream_module.requests.Session.get
    original_spool_lookup = stream_module._find_spooled_file
    original_spool_directory = stream_module.YTMUSIC_SPOOL_DIR
    original_spool_timeout = stream_module.YTMUSIC_SPOOL_TIMEOUT
    stream_module._get_stream_url_sync = upstream.stream_info_provider

    def session_stream_response(_client: object, *args: Any, **kwargs: Any) -> Any:
        return upstream.stream_response(*args, **kwargs)

    stream_module.requests.Session.get = session_stream_response
    lookup_profiler = _FilesystemLookupProfiler(original_spool_lookup)
    stream_module._find_spooled_file = lookup_profiler
    stream_module.YTMUSIC_SPOOL_DIR = spool_directory
    stream_module.YTMUSIC_SPOOL_TIMEOUT = 3.0

    ids = base._IdSource()
    clients: list[httpx.AsyncClient] = []
    rapid_next_clients: list[httpx.AsyncClient] = []
    httpx_logger = logging.getLogger("httpx")
    sidecar_logger = logging.getLogger("ytmusic-streamer")
    prior_httpx_level = httpx_logger.level
    prior_sidecar_level = sidecar_logger.level
    httpx_logger.setLevel(logging.WARNING)
    sidecar_logger.setLevel(logging.CRITICAL)
    try:
        async with base._LocalServer(probe, listeners) as local:
            if local.client is None:
                raise RuntimeError("Local sidecar client was not initialized")
            clients = await _new_listener_clients(local.base_url, listeners)

            cold_ids = ids.many(listeners)
            cold, _cold_generation = await _run_held_wave(
                base,
                clients,
                upstream,
                stream_module,
                probe,
                lookup_profiler,
                cold_ids,
                phase="playback-cold-staggered",
                stagger_seconds=cold_stagger_ms / 1000,
                hold_seconds=hold_ms / 1000,
            )

            warm_ids = ids.many(listeners)
            await base._prefill_streams(
                local.client,
                upstream,
                stream_module,
                warm_ids,
                "playback-warm-prefill",
            )
            preconnect_ms = (
                await _preconnect_listener_clients(clients) if preconnect_listeners else None
            )
            warm, _warm_generation = await _run_held_wave(
                base,
                clients,
                upstream,
                stream_module,
                probe,
                lookup_profiler,
                warm_ids,
                phase="playback-warm-concurrent",
                stagger_seconds=0.0,
                hold_seconds=hold_ms / 1000,
            )
            warm["playbackUpstreamResolveCalls"] = warm.pop("upstreamResolveCalls")
            warm["playbackUpstreamTransferCalls"] = warm.pop("upstreamTransferCalls")

            if preconnect_listeners:
                rapid_next_clients = await _new_listener_clients(local.base_url, listeners)
                rapid_preconnect_ms = await _preconnect_listener_clients(rapid_next_clients)
            else:
                rapid_next_clients = clients
                rapid_preconnect_ms = None
            rapid = await _run_rapid_skip(
                base,
                clients,
                rapid_next_clients,
                upstream,
                stream_module,
                probe,
                lookup_profiler,
                cold_ids,
                warm_ids,
                hold_seconds=hold_ms / 1000,
            )

        retained = upstream.cleanup_generated_spool()
        report: dict[str, Any] = {
            "mode": "local-sidecar-playback-transport",
            "listeners": listeners,
            "providerNetworkRequests": 0,
            "scope": {
                "real": [
                    "loopback TCP and uvicorn",
                    "FastAPI /proxy route",
                    "singleflight, admission, provider and transfer budgets",
                    "progressive spool, completed-file cache, cancellation and response pins",
                ],
                "replaced": [
                    "YouTube stream resolve",
                    "CDN bytes",
                    "slow listener network backpressure after first byte",
                ],
                "notIncluded": [
                    "frontend AudioPlaybackOrchestrator and audio engine",
                    "backend Express proxy and auth/rate limiting",
                    "browser media decode and audio output",
                ],
            },
            "measurementDefinitions": {
                "serverReadyMs": "HTTP response headers observed by the loopback client",
                "firstByteMs": "first response body byte observed by the loopback client",
                "requestMs": (
                    "full response completion, including the intentional cohort ramp, barrier, "
                    "and hold; it is not playback-start latency"
                ),
                "browserAudible": {
                    "measured": False,
                    "reason": "No browser decoder or audio output event participates in this workload.",
                },
                "activePlaybackStream": (
                    "A distinct /proxy response that delivered its first byte and remains held "
                    "by deterministic downstream backpressure."
                ),
                "serverTiming": (
                    "monotonic in-process timing from client task scheduling through ASGI entry, "
                    "response headers, and the first body send"
                ),
                "filesystemLookup": (
                    "completed-spool lookup duration including time waiting for the prune lock"
                ),
                "eventLoopLagMs": "10 ms timer overshoot while the held wave is active",
            },
            "coldStaggerMs": cold_stagger_ms,
            "holdMs": hold_ms,
            "listenerPreconnect": {
                "enabled": preconnect_listeners,
                "warmDurationMs": base._round(preconnect_ms) if preconnect_ms is not None else None,
                "rapidNextDurationMs": (
                    base._round(rapid_preconnect_ms) if rapid_preconnect_ms is not None else None
                ),
                "rapidNextUsesSparePool": preconnect_listeners,
            },
            "coldStaggeredDistinct": cold,
            "warmConcurrentDistinct": warm,
            "rapidSkipPrepared": rapid,
            "observedBounds": {
                "providerPeak": upstream.stream_peak,
                "providerLimit": stream_module.YTDLP_EXTRACT_CONCURRENCY,
                "transferPeak": upstream.transfer_peak,
                "transferLimit": stream_module.YTMUSIC_SPOOL_CONCURRENCY,
                "retainedSpoolFilesBeforeCleanup": retained["files"],
                "retainedSpoolBytesBeforeCleanup": retained["bytes"],
            },
            "protocolCoverage": {
                "progressive": True,
                "hlsFallback": False,
                "aggregateUncertainty": (
                    "This does not prove the combined peak when progressive transfer and HLS "
                    "fallback downloads overlap; those paths still use separate active lanes."
                ),
            },
            "interpretation": (
                "Immediate 100-distinct-cold fanout is intentionally admission-bounded and is "
                "not claimed. This workload tests 100 simultaneously held playback responses "
                "after cold starts arrive at a controlled sustainable rate, plus fully prepared "
                "warm and rapid-skip waves."
            ),
        }
        transport_issues = _transport_capacity_issues(report)
        prepared_latency_target_ms = 500.0
        warm_first_byte_p95 = float(warm["http"]["latency"]["firstByteMs"]["p95"])
        rapid_first_byte_p95 = float(rapid["next"]["latency"]["firstByteMs"]["p95"])
        latency_issues = []
        if warm_first_byte_p95 > prepared_latency_target_ms:
            latency_issues.append("warm prepared first-byte p95 exceeded the 500 ms target")
        if rapid_first_byte_p95 > prepared_latency_target_ms:
            latency_issues.append("rapid-skip prepared first-byte p95 exceeded the 500 ms target")
        prepared_latency_met = not latency_issues
        report["acceptance"] = {
            "transportCapacityPassed": not transport_issues,
            "transportCapacityIssues": transport_issues,
            "preparedLatencyTargetMs": prepared_latency_target_ms,
            "preparedLatencyMet": prepared_latency_met,
            "preparedLatencyIssues": latency_issues,
            "overallPassed": not transport_issues and prepared_latency_met,
        }
        return report
    finally:
        probe.release_current()
        if clients:
            await asyncio.gather(*(client.aclose() for client in clients), return_exceptions=True)
        if rapid_next_clients and rapid_next_clients is not clients:
            await asyncio.gather(
                *(client.aclose() for client in rapid_next_clients),
                return_exceptions=True,
            )
        with suppress(Exception):
            await stream_module.shutdown_stream_provider()
        stream_module._get_stream_url_sync = original_stream_info_provider
        stream_module.requests.Session.get = original_stream_response
        stream_module._find_spooled_file = original_spool_lookup
        stream_module.YTMUSIC_SPOOL_DIR = original_spool_directory
        stream_module.YTMUSIC_SPOOL_TIMEOUT = original_spool_timeout
        httpx_logger.setLevel(prior_httpx_level)
        sidecar_logger.setLevel(prior_sidecar_level)
        if temporary is not None:
            temporary.cleanup()


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--listeners", type=int, default=100)
    parser.add_argument("--cold-stagger-ms", type=float, default=275.0)
    parser.add_argument("--hold-ms", type=float, default=5000.0)
    parser.add_argument("--preconnect-listeners", action="store_true")
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()
    try:
        report = asyncio.run(
            run_playback_workload(
                listeners=args.listeners,
                cold_stagger_ms=args.cold_stagger_ms,
                hold_ms=args.hold_ms,
                preconnect_listeners=args.preconnect_listeners,
            )
        )
    except (AssertionError, RuntimeError, TimeoutError, TypeError, ValueError) as error:
        sys.stderr.write(f"Playback workload failed: {error}\n")
        return 1
    rendered = json.dumps(report, ensure_ascii=False, indent=2) + "\n"
    if args.output is None:
        sys.stdout.write(rendered)
    else:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(rendered, encoding="utf-8")
        sys.stdout.write(f"Wrote local playback workload report to {args.output}\n")
    return 0 if report["acceptance"]["overallPassed"] else 2


if __name__ == "__main__":
    raise SystemExit(main())
