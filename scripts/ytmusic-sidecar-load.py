#!/usr/bin/env python3
"""Run deterministic load through the real local YouTube Music sidecar.

The harness starts the production FastAPI application on a loopback TCP socket.
Only the final provider calls are replaced: public search, stream resolution,
and progressive CDN bytes. No request can reach YouTube or a deployed Soundspan
instance.
"""

from __future__ import annotations

import argparse
import asyncio
import hashlib
import importlib
import json
import logging
import os
import secrets
import socket
import sys
import tempfile
import threading
import time
from collections import Counter, defaultdict
from collections.abc import Awaitable, Callable, Iterable, Sequence
from contextlib import suppress
from pathlib import Path
from typing import Any, Literal

import httpx
import uvicorn
from fastapi import HTTPException

DEFAULT_STAGES = (20, 50, 100, 120)
MAX_STAGE = 200
_INTERNAL_SECRET = secrets.token_urlsafe(24)
_QUALITY = "HIGH"
_MEDIA_PREFIX = b"\x1aE\xdf\xa3" + (b"soundspan-local-load" * 128) + b"\x1fC\xb6u"
_MEDIA_TAIL = b"\x00" * 4096
_REPOSITORY_ROOT = Path(__file__).resolve().parents[1]


def _round(value: float) -> float:
    return round(value, 3)


def _quantile(values: Sequence[float], fraction: float) -> float | None:
    if not values:
        return None
    ordered = sorted(values)
    position = (len(ordered) - 1) * fraction
    lower = int(position)
    upper = min(lower + 1, len(ordered) - 1)
    return _round(ordered[lower] + (ordered[upper] - ordered[lower]) * (position - lower))


def _latency_summary(samples: Sequence[dict[str, Any]]) -> dict[str, Any]:
    keys = ("requestMs", "serverReadyMs", "firstByteMs", "upstreamStartWaitMs")
    summary: dict[str, Any] = {"samples": len(samples)}
    for key in keys:
        values = [
            float(sample[key]) for sample in samples if isinstance(sample.get(key), int | float)
        ]
        if values:
            summary[key] = {"p50": _quantile(values, 0.5), "p95": _quantile(values, 0.95)}
    return summary


def _classify_status(status: int | None, *, cancelled: bool = False) -> str:
    if cancelled:
        return "cancelled"
    if status in {404, 410, 451}:
        return "unavailable"
    if status == 429:
        return "rate_limit"
    if status in {408, 504}:
        return "timeout"
    if status == 503:
        return "capacity"
    return "failed"


def _summarize(results: Sequence[dict[str, Any]]) -> dict[str, Any]:
    successes = [result for result in results if result.get("ok") is True]
    errors = Counter(
        str(result.get("error") or "failed") for result in results if result.get("ok") is not True
    )
    summary = {
        "successes": len(successes),
        "failures": len(results) - len(successes),
        "errors": dict(sorted(errors.items())),
        "latency": _latency_summary(successes),
    }
    error_details = Counter(
        str(result["errorDetail"])
        for result in results
        if result.get("ok") is not True and result.get("errorDetail")
    )
    if error_details:
        summary["errorDetails"] = dict(sorted(error_details.items()))
    error_messages = Counter(
        str(result["errorMessage"])
        for result in results
        if result.get("ok") is not True and result.get("errorMessage")
    )
    if error_messages:
        summary["errorMessages"] = dict(sorted(error_messages.items()))
    return summary


def _acceptance_issues(report: dict[str, Any]) -> list[str]:
    """Return invariant failures without treating deliberate admission rejects as defects."""
    issues: list[str] = []
    for stage in report["stages"]:
        listeners = stage["listeners"]
        search = stage["search"]
        stream = stage["stream"]
        tail = stage["tail"]
        required_successes = (
            ("search.sameQueryCold", search["sameQueryCold"]),
            ("search.sameQueryWarm", search["sameQueryWarm"]),
            ("stream.sameTrackCold", stream["sameTrackCold"]),
            ("stream.warmDistinct", stream["warmDistinct"]),
            ("stream.rapidSkip.final", stream["rapidSkip"]["final"]),
        )
        for name, summary in required_successes:
            if summary["successes"] != listeners or summary["failures"]:
                issues.append(f"stage {listeners}: {name} did not serve every listener")
        if search["sameQueryCold"]["upstreamCalls"] != 1:
            issues.append(f"stage {listeners}: search same-query singleflight was not one call")
        if search["sameQueryWarm"]["upstreamCalls"] != 0:
            issues.append(f"stage {listeners}: warm search unexpectedly reached upstream")
        if stream["sameTrackCold"]["upstreamCalls"] != 1:
            issues.append(f"stage {listeners}: stream same-track singleflight was not one call")
        if stream["sameTrackCold"]["peakActiveStreamLeases"] != listeners:
            issues.append(
                f"stage {listeners}: same-track HTTP streams were not concurrently active"
            )
        if stream["sameTrackCold"]["peakPendingJobs"] != 1:
            issues.append(f"stage {listeners}: same-track load did not share one pending job")
        if stream["sameTrackCold"]["peakProviderWorkers"] != 1:
            issues.append(f"stage {listeners}: same-track load did not share one provider worker")
        if stream["warmDistinct"]["upstreamCalls"] != 0:
            issues.append(f"stage {listeners}: warm stream unexpectedly reached upstream")
        if stream["rapidSkip"]["cancelled"] != listeners:
            issues.append(f"stage {listeners}: rapid-skip clients did not all cancel")
        if stream["rapidSkip"]["upstreamCallsBeforeCancel"] != 1:
            issues.append(f"stage {listeners}: rapid-skip shared work was duplicated")
        if set(search["mixedCachedCold"]["errors"]) - {"capacity"}:
            issues.append(f"stage {listeners}: search mixed load had an unexpected error")
        for name in ("coldDistinct", "mixedCachedCold"):
            if set(stream[name]["errors"]) - {"capacity", "timeout"}:
                issues.append(f"stage {listeners}: stream {name} had an unexpected error")
        for fault in ("unavailable", "timeout"):
            summary = stream["faults"][fault]
            if summary["successes"] or summary["errors"] != {fault: listeners}:
                issues.append(f"stage {listeners}: {fault} faults were misclassified")
            if summary["upstreamCalls"] != 1:
                issues.append(
                    f"stage {listeners}: {fault} fault wave escaped singleflight cooldown"
                )
            if summary["cooldownReplay"].get("error") != fault:
                issues.append(f"stage {listeners}: {fault} cooldown replay was not classified")
            if summary["joinedWaitersAtRelease"] < min(listeners, 50):
                issues.append(f"stage {listeners}: {fault} wave lacked concurrent waiters")
        if not tail["generationReplaced"]:
            issues.append(f"stage {listeners}: tail generation replacement did not cancel old work")
        if tail["http"]["failures"] or tail["finalStatuses"] != {"complete": listeners * 4}:
            issues.append(f"stage {listeners}: tail warmup did not complete cleanly")

    bounds = report["observedBounds"]
    bounded_pairs = (
        ("streamProviderPeak", "streamProviderLimit"),
        ("streamTransferPeak", "streamTransferLimit"),
        ("searchProviderPeak", "searchProviderLimit"),
        ("maxSpoolPending", "spoolPendingLimit"),
        ("maxTailJobs", "tailCapacity"),
        ("tailOwners", "tailOwnerCapacity"),
        ("maxSearchCacheEntries", "searchCacheLimit"),
        ("maxRetainedSpoolBytes", "spoolByteLimit"),
        ("maxSpoolReservedBytes", "spoolByteLimit"),
        ("maxSpoolFailureCacheEntries", "spoolFailureCacheLimit"),
    )
    for observed, limit in bounded_pairs:
        if bounds[observed] > bounds[limit]:
            issues.append(f"observed bound {observed} exceeded {limit}")
    if bounds["spoolFiles"] or bounds["spoolBytes"]:
        issues.append("deterministic spool files remained after workload cleanup")
    if bounds["tailInterests"] or bounds["tailVersions"]:
        issues.append("tail interests remained after generation cleanup")
    keepalive = report["transportProfiles"]["perListenerKeepAlive"]
    keepalive_listeners = keepalive["listeners"]
    for wave in ("firstWave", "immediateReuseWave", "afterServerIdleWave"):
        if keepalive[wave]["successes"] != keepalive_listeners or keepalive[wave]["failures"]:
            issues.append(f"keepalive transport {wave} did not serve every listener")
    if keepalive["firstWaveUpstreamCalls"] != 1:
        issues.append("keepalive transport did not singleflight its cold search")
    if keepalive["immediateWaveUpstreamCalls"] or keepalive["afterIdleWaveUpstreamCalls"]:
        issues.append("keepalive transport warm search unexpectedly reached upstream")
    if keepalive["immediateReuseConnections"] != keepalive_listeners:
        issues.append("per-listener keepalive connections were not immediately reused")
    if keepalive["reconnectedAfterServerIdle"] != keepalive_listeners:
        issues.append("per-listener pools did not recover from server idle close")
    return issues


class _DeterministicUpstream:
    """Thread-safe fake installed exactly at the two external provider seams."""

    def __init__(self, stream_module: Any, spool_directory: Path) -> None:
        self._stream = stream_module
        self._spool_directory = spool_directory
        self._lock = threading.Lock()
        self._phase = "setup"
        self._stream_active = 0
        self._transfer_active = 0
        self._search_active = 0
        self.stream_peak = 0
        self.transfer_peak = 0
        self.spool_reserved_peak = 0
        self.search_peak = 0
        self.phase_stream_peak: dict[str, int] = defaultdict(int)
        self.phase_search_peak: dict[str, int] = defaultdict(int)
        self.stream_calls: Counter[tuple[str, str]] = Counter()
        self.transfer_calls: Counter[tuple[str, str]] = Counter()
        self.search_calls: Counter[tuple[str, str]] = Counter()
        self.stream_modes: dict[str, str] = {}
        self.phase_gates: dict[str, threading.Event] = {}
        self.client_started: dict[tuple[str, str], float] = {}
        self.upstream_started: dict[tuple[str, str], float] = {}
        self.generated_paths: set[Path] = set()
        self._resolved_sources: dict[str, tuple[str, str, str]] = {}
        self.cancelled_stream_calls = 0

    def set_phase(self, phase: str) -> None:
        with self._lock:
            self._phase = phase

    def record_client_start(self, kind: str, key: str, started_at: float) -> None:
        with self._lock:
            identity = (kind, key)
            existing = self.client_started.get(identity)
            self.client_started[identity] = (
                started_at if existing is None else min(existing, started_at)
            )

    def set_stream_mode(self, video_id: str, mode: str) -> None:
        self.stream_modes[video_id] = mode

    def gate_phase(self, phase: str) -> threading.Event:
        gate = threading.Event()
        self.phase_gates[phase] = gate
        return gate

    def stream_call_count(self, phase: str) -> int:
        with self._lock:
            return sum(
                count
                for (recorded_phase, _key), count in self.stream_calls.items()
                if recorded_phase == phase
            )

    def search_call_count(self, phase: str) -> int:
        with self._lock:
            return sum(
                count
                for (recorded_phase, _key), count in self.search_calls.items()
                if recorded_phase == phase
            )

    def transfer_call_count(self, phase: str) -> int:
        with self._lock:
            return sum(
                count
                for (recorded_phase, _key), count in self.transfer_calls.items()
                if recorded_phase == phase
            )

    def wait_samples(self, kind: str, keys: Iterable[str]) -> list[float]:
        samples: list[float] = []
        with self._lock:
            for key in keys:
                client = self.client_started.get((kind, key))
                upstream = self.upstream_started.get((kind, key))
                if client is not None and upstream is not None:
                    samples.append(_round(max(0.0, (upstream - client) * 1000)))
        return samples

    @property
    def active(self) -> int:
        with self._lock:
            return self._stream_active + self._search_active

    def search_provider(
        self,
        user_id: str,
        query: str,
        filter_: Literal["songs", "albums", "artists", "videos"] | None,
        limit: int,
        use_unauth_client: bool = False,
    ) -> tuple[list[dict[str, Any]], Literal["tv", "native"]]:
        """Return deterministic public results from the real search executor."""
        if user_id != "__public__" or not use_unauth_client:
            raise AssertionError("Workload search escaped the public provider strategy")
        key = f"{query}|{filter_ or ''}|{limit}"
        with self._lock:
            phase = self._phase
            self.search_calls[(phase, key)] += 1
            self._search_active += 1
            self.search_peak = max(self.search_peak, self._search_active)
            self.phase_search_peak[phase] = max(self.phase_search_peak[phase], self._search_active)
            self.upstream_started.setdefault(("search", query), time.perf_counter())
        try:
            gate = self.phase_gates.get(phase)
            if gate is not None and not gate.wait(timeout=5):
                raise TimeoutError("deterministic search admission gate was not released")
            time.sleep(0.02)
            digest = hashlib.sha256(key.encode()).hexdigest()
            video_id = f"S{int(digest[:12], 16) % 10_000_000_000:010d}"
            return (
                [
                    {
                        "videoId": video_id,
                        "title": f"Local result for {query}",
                        "artist": "Deterministic upstream",
                        "type": "song",
                    }
                ],
                "native",
            )
        finally:
            with self._lock:
                self._search_active -= 1

    def stream_info_provider(self, user_id: str, video_id: str, quality: str) -> dict[str, Any]:
        """Resolve deterministic media through the real extraction-budget boundary."""
        if user_id != "__public__":
            raise AssertionError("Workload stream escaped the public provider strategy")
        key = f"{video_id}:{quality}"
        with self._lock:
            phase = self._phase
            self.stream_calls[(phase, key)] += 1
            self._stream_active += 1
            self.stream_peak = max(self.stream_peak, self._stream_active)
            self.phase_stream_peak[phase] = max(self.phase_stream_peak[phase], self._stream_active)
            self.upstream_started.setdefault(("stream", key), time.perf_counter())
        mode = self.stream_modes.get(video_id, "normal")
        try:
            cancel_event = self._stream._spool_cancel_events.get(key, threading.Event())
            if mode in {"unavailable", "timeout"}:
                gate = self.phase_gates.get(phase)
                if gate is not None:
                    while not gate.wait(timeout=0.005):
                        if cancel_event.is_set():
                            raise self._stream._SpoolDownloadCancelled(
                                "deterministic request cancelled"
                            )
            if mode == "unavailable":
                self._sleep_or_cancel(cancel_event, 0.06)
                raise HTTPException(status_code=404, detail="deterministic content unavailable")
            if mode == "timeout":
                self._sleep_or_cancel(cancel_event, 0.06)
                raise HTTPException(status_code=504, detail="deterministic provider timeout")
            self._sleep_or_cancel(cancel_event, 0.02)
            source_url = f"https://soundspan.invalid/media/{secrets.token_urlsafe(12)}"
            partial = self._spool_directory / f"{video_id}-{quality}.webm.soundspan-part"
            completed = self._spool_directory / f"{video_id}-{quality}.webm"
            with self._lock:
                self._resolved_sources[source_url] = (phase, video_id, quality)
                self.generated_paths.update((partial, completed))
            return {
                "url": source_url,
                "protocol": "https",
                "ext": "webm",
                "content_type": "audio/webm",
            }
        finally:
            with self._lock:
                self._stream_active -= 1

    def stream_response(self, url: str, **options: Any) -> _DeterministicStreamResponse:
        """Return a requests-compatible deterministic CDN response."""
        if options.get("stream") is not True:
            raise AssertionError("Progressive workload source was not opened as a stream")
        with self._lock:
            source = self._resolved_sources.get(url)
            self.spool_reserved_peak = max(
                self.spool_reserved_peak,
                int(self._stream._spool_reserved_bytes),
            )
        if source is None:
            raise AssertionError("Workload attempted an unknown progressive source")
        return _DeterministicStreamResponse(self, *source)

    def iter_stream_body(self, phase: str, video_id: str, quality: str) -> Iterable[bytes]:
        """Yield deterministic CDN chunks while honoring real spool cancellation."""
        key = f"{video_id}:{quality}"
        cancel_event = self._stream._spool_cancel_events.get(key, threading.Event())
        with self._lock:
            self.transfer_calls[(phase, key)] += 1
            self._transfer_active += 1
            self.transfer_peak = max(self.transfer_peak, self._transfer_active)
        try:
            gate = self.phase_gates.get(phase)
            if gate is not None:
                while not gate.wait(timeout=0.005):
                    if cancel_event.is_set():
                        raise self._stream._SpoolDownloadCancelled(
                            "deterministic request cancelled"
                        )
            mode = self.stream_modes.get(video_id, "normal")
            readable_delay = 0.2 if mode == "slow" else 0.012
            self._sleep_or_cancel(cancel_event, readable_delay)
            yield _MEDIA_PREFIX
            completion_delay = 0.025 if "-tail-" in phase or "-prefill" in phase else 0.5
            self._sleep_or_cancel(cancel_event, completion_delay)
            yield _MEDIA_TAIL
        except self._stream._SpoolDownloadCancelled:
            with self._lock:
                self.cancelled_stream_calls += 1
            raise
        finally:
            with self._lock:
                self._transfer_active -= 1

    def _sleep_or_cancel(self, cancel_event: threading.Event, seconds: float) -> None:
        deadline = time.monotonic() + seconds
        while True:
            if cancel_event.is_set():
                raise self._stream._SpoolDownloadCancelled("deterministic request cancelled")
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                return
            time.sleep(min(0.005, remaining))

    def cleanup_generated_spool(self) -> dict[str, int]:
        """Remove only files this deterministic upstream created."""
        with self._lock:
            paths = tuple(self.generated_paths)
        existing = [path for path in paths if path.is_file()]
        snapshot = {
            "files": len(existing),
            "bytes": sum(path.stat().st_size for path in existing),
        }
        for path in paths:
            with suppress(FileNotFoundError):
                path.unlink()
        return snapshot


class _DeterministicStreamResponse:
    """Minimal requests response backed by the deterministic CDN iterator."""

    def __init__(
        self,
        upstream: _DeterministicUpstream,
        phase: str,
        video_id: str,
        quality: str,
    ) -> None:
        self._upstream = upstream
        self._phase = phase
        self._video_id = video_id
        self._quality = quality
        self.status_code = 200
        self.headers = {
            "Content-Encoding": "identity",
            "Content-Length": str(len(_MEDIA_PREFIX) + len(_MEDIA_TAIL)),
        }

    def __enter__(self) -> _DeterministicStreamResponse:
        return self

    def __exit__(self, *args: object) -> None:
        return None

    def raise_for_status(self) -> None:
        return None

    def iter_content(self, *, chunk_size: int) -> Iterable[bytes]:
        if chunk_size <= 0:
            raise AssertionError("Progressive workload used an invalid chunk size")
        return self._upstream.iter_stream_body(self._phase, self._video_id, self._quality)


class _LocalServer:
    def __init__(self, app: Any, listeners: int) -> None:
        self._app = app
        self._listeners = listeners
        self._socket: socket.socket | None = None
        self._server: uvicorn.Server | None = None
        self._task: asyncio.Task[None] | None = None
        self.client: httpx.AsyncClient | None = None
        self.base_url = ""
        self.keep_alive_timeout = 0.0

    async def __aenter__(self) -> _LocalServer:
        sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        sock.bind(("127.0.0.1", 0))
        sock.listen(max(256, self._listeners + 16))
        sock.setblocking(False)
        port = int(sock.getsockname()[1])
        config = uvicorn.Config(
            self._app,
            host="127.0.0.1",
            port=port,
            log_level="error",
            access_log=False,
            lifespan="off",
        )
        server = uvicorn.Server(config)
        self.base_url = f"http://127.0.0.1:{port}"
        self.keep_alive_timeout = float(config.timeout_keep_alive)
        self._socket = sock
        self._server = server
        self._task = asyncio.create_task(server.serve(sockets=[sock]))
        deadline = time.monotonic() + 5
        while not server.started:
            if self._task.done():
                await self._task
                raise RuntimeError("Local sidecar stopped before becoming ready")
            if time.monotonic() >= deadline:
                raise TimeoutError("Local sidecar did not become ready")
            await asyncio.sleep(0.005)
        self.client = httpx.AsyncClient(
            base_url=self.base_url,
            headers={"x-internal-secret": _INTERNAL_SECRET},
            timeout=httpx.Timeout(30.0),
            limits=httpx.Limits(
                max_connections=max(256, self._listeners + 32),
                # One HTTPX pool represents many independent listeners. Do not
                # reuse a server-expired idle socket across later workload
                # phases; real browsers would own separate connection pools.
                max_keepalive_connections=0,
            ),
        )
        return self

    async def __aexit__(self, *_error: object) -> None:
        if self.client is not None:
            await self.client.aclose()
        if self._server is not None:
            self._server.should_exit = True
        if self._task is not None:
            with suppress(asyncio.CancelledError):
                await asyncio.wait_for(self._task, timeout=5)
        if self._socket is not None:
            with suppress(OSError):
                self._socket.close()


class _IdSource:
    def __init__(self) -> None:
        self._next = 0

    def one(self) -> str:
        self._next += 1
        return f"L{self._next:010d}"

    def many(self, count: int) -> list[str]:
        return [self.one() for _ in range(count)]


async def _observe_stream(
    client: httpx.AsyncClient,
    upstream: _DeterministicUpstream,
    video_id: str,
    *,
    consume_full: bool,
    purpose: str = "interactive",
) -> dict[str, Any]:
    started = time.perf_counter()
    key = f"{video_id}:{_QUALITY}"
    upstream.record_client_start("stream", key, started)
    try:
        async with client.stream(
            "GET",
            f"/proxy/{video_id}",
            params={"user_id": "__public__", "quality": _QUALITY, "purpose": purpose},
        ) as response:
            ready = time.perf_counter()
            if response.status_code != 200:
                await response.aread()
                return {
                    "ok": False,
                    "status": response.status_code,
                    "error": _classify_status(response.status_code),
                    "requestMs": _round((time.perf_counter() - started) * 1000),
                    "serverReadyMs": _round((ready - started) * 1000),
                }
            first_at: float | None = None
            async for chunk in response.aiter_bytes():
                if chunk and first_at is None:
                    first_at = time.perf_counter()
                    if not consume_full:
                        break
            if first_at is None:
                return {"ok": False, "error": "empty_body", "status": response.status_code}
            finished = time.perf_counter()
            return {
                "ok": True,
                "requestMs": _round((finished - started) * 1000),
                "serverReadyMs": _round((ready - started) * 1000),
                "firstByteMs": _round((first_at - started) * 1000),
            }
    except asyncio.CancelledError:
        return {"ok": False, "error": "cancelled", "cancelled": True}
    except httpx.TimeoutException:
        return {"ok": False, "error": "client_timeout"}
    except httpx.HTTPError as error:
        return {
            "ok": False,
            "error": "network",
            "errorDetail": type(error).__name__,
            "errorMessage": str(error)[:240],
        }


async def _observe_search(
    client: httpx.AsyncClient,
    upstream: _DeterministicUpstream,
    query: str,
) -> dict[str, Any]:
    started = time.perf_counter()
    upstream.record_client_start("search", query, started)
    try:
        response = await client.post(
            "/search",
            params={"user_id": "load-user"},
            json={"query": query, "filter": "songs", "limit": 5},
        )
    except httpx.TimeoutException:
        return {"ok": False, "error": "client_timeout"}
    except httpx.HTTPError as error:
        return {
            "ok": False,
            "error": "network",
            "errorDetail": type(error).__name__,
            "errorMessage": str(error)[:240],
        }
    elapsed = _round((time.perf_counter() - started) * 1000)
    if response.status_code != 200:
        return {
            "ok": False,
            "status": response.status_code,
            "error": _classify_status(response.status_code),
            "requestMs": elapsed,
        }
    return {"ok": True, "requestMs": elapsed}


def _response_connection_identity(response: httpx.Response) -> str | None:
    network_stream = response.extensions.get("network_stream")
    get_extra_info = getattr(network_stream, "get_extra_info", None)
    if not callable(get_extra_info):
        return None
    connected_socket = get_extra_info("socket")
    if connected_socket is None:
        return None
    try:
        return f"{connected_socket.getsockname()!r}->{connected_socket.getpeername()!r}"
    except OSError:
        return None


async def _observe_keepalive_search(
    client: httpx.AsyncClient,
    query: str,
) -> dict[str, Any]:
    started = time.perf_counter()
    try:
        async with client.stream(
            "POST",
            "/search",
            params={"user_id": "keepalive-user"},
            json={"query": query, "filter": "songs", "limit": 5},
        ) as response:
            connection = _response_connection_identity(response)
            await response.aread()
            elapsed = _round((time.perf_counter() - started) * 1000)
            if response.status_code != 200:
                return {
                    "ok": False,
                    "status": response.status_code,
                    "error": _classify_status(response.status_code),
                    "requestMs": elapsed,
                    "connection": connection,
                }
            return {"ok": True, "requestMs": elapsed, "connection": connection}
    except httpx.TimeoutException as error:
        return {
            "ok": False,
            "error": "client_timeout",
            "errorDetail": type(error).__name__,
        }
    except httpx.HTTPError as error:
        return {
            "ok": False,
            "error": "network",
            "errorDetail": type(error).__name__,
            "errorMessage": str(error)[:240],
        }


async def _run_keepalive_transport_profile(
    listeners: int,
    server: _LocalServer,
    upstream: _DeterministicUpstream,
) -> dict[str, Any]:
    """Reuse one keepalive pool per listener, including after server idle close."""
    clients = [
        httpx.AsyncClient(
            base_url=server.base_url,
            headers={"x-internal-secret": _INTERNAL_SECRET},
            timeout=httpx.Timeout(30.0),
            limits=httpx.Limits(
                max_connections=1,
                max_keepalive_connections=1,
                keepalive_expiry=max(30.0, server.keep_alive_timeout * 3),
            ),
        )
        for _ in range(listeners)
    ]
    query = f"sidecar per-listener keepalive {listeners}"
    first_phase = f"{listeners}-transport-keepalive-first"
    immediate_phase = f"{listeners}-transport-keepalive-immediate"
    idle_phase = f"{listeners}-transport-keepalive-after-idle"
    try:
        upstream.set_phase(first_phase)
        first = await asyncio.gather(
            *(_observe_keepalive_search(client, query) for client in clients)
        )
        upstream.set_phase(immediate_phase)
        immediate = await asyncio.gather(
            *(_observe_keepalive_search(client, query) for client in clients)
        )
        idle_seconds = server.keep_alive_timeout + 0.25
        await asyncio.sleep(idle_seconds)
        upstream.set_phase(idle_phase)
        after_idle = await asyncio.gather(
            *(_observe_keepalive_search(client, query) for client in clients)
        )
    finally:
        await asyncio.gather(*(client.aclose() for client in clients))

    first_connections = [item.get("connection") for item in first]
    immediate_connections = [item.get("connection") for item in immediate]
    idle_connections = [item.get("connection") for item in after_idle]
    return {
        "listeners": listeners,
        "endpoint": "/search",
        "onePoolPerListener": True,
        "serverKeepAliveSeconds": server.keep_alive_timeout,
        "idleSeconds": idle_seconds,
        "firstWave": _summarize(first),
        "immediateReuseWave": _summarize(immediate),
        "afterServerIdleWave": _summarize(after_idle),
        "firstWaveUpstreamCalls": upstream.search_call_count(first_phase),
        "immediateWaveUpstreamCalls": upstream.search_call_count(immediate_phase),
        "afterIdleWaveUpstreamCalls": upstream.search_call_count(idle_phase),
        "observedConnections": sum(connection is not None for connection in first_connections),
        "immediateReuseConnections": sum(
            first_connection is not None and first_connection == immediate_connection
            for first_connection, immediate_connection in zip(
                first_connections, immediate_connections, strict=True
            )
        ),
        "reconnectedAfterServerIdle": sum(
            immediate_connection is not None
            and idle_connection is not None
            and immediate_connection != idle_connection
            for immediate_connection, idle_connection in zip(
                immediate_connections, idle_connections, strict=True
            )
        ),
    }


async def _wait_until(
    predicate: Callable[[], bool], label: str, timeout_seconds: float = 3.0
) -> None:
    deadline = time.monotonic() + timeout_seconds
    while not predicate():
        if time.monotonic() >= deadline:
            raise TimeoutError(f"Timed out waiting for {label}")
        await asyncio.sleep(0.002)


async def _run_tracked(
    awaitable: Awaitable[list[dict[str, Any]]],
    runtime_size: Callable[[], int],
) -> tuple[list[dict[str, Any]], int]:
    task = asyncio.ensure_future(awaitable)
    peak = runtime_size()
    while not task.done():
        peak = max(peak, runtime_size())
        await asyncio.sleep(0.001)
    return await task, max(peak, runtime_size())


async def _run_gated_tracked(
    awaitable: Awaitable[list[dict[str, Any]]],
    runtime_size: Callable[[], int],
    target_size: int,
    gate: threading.Event,
) -> tuple[list[dict[str, Any]], int]:
    task = asyncio.ensure_future(awaitable)
    peak = runtime_size()
    try:
        await _wait_until(
            lambda: runtime_size() >= target_size or task.done(),
            "bounded admission filling",
            timeout_seconds=15,
        )
        peak = max(peak, runtime_size())
        await asyncio.sleep(0.05)
    finally:
        gate.set()
    while not task.done():
        peak = max(peak, runtime_size())
        await asyncio.sleep(0.001)
    return await task, max(peak, runtime_size())


async def _stream_batch(
    client: httpx.AsyncClient,
    upstream: _DeterministicUpstream,
    video_ids: Sequence[str],
    *,
    consume_full: bool,
    purpose: str = "interactive",
) -> list[dict[str, Any]]:
    return await asyncio.gather(
        *(
            _observe_stream(
                client,
                upstream,
                video_id,
                consume_full=consume_full,
                purpose=purpose,
            )
            for video_id in video_ids
        )
    )


async def _wait_stream_idle(stream_module: Any, upstream: _DeterministicUpstream) -> None:
    await _wait_until(
        lambda: (
            upstream.active == 0
            and stream_module._spool_pending_jobs == 0
            and not stream_module._spool_tasks
        ),
        "stream workload idle",
        timeout_seconds=5,
    )


async def _run_stream_fault_wave(
    stage: int,
    client: httpx.AsyncClient,
    upstream: _DeterministicUpstream,
    stream_module: Any,
    *,
    phase: str,
    video_id: str,
    expected_error: str,
) -> tuple[dict[str, Any], int]:
    """Release one provider fault only after every concurrent HTTP waiter joined."""
    upstream.set_phase(phase)
    gate = upstream.gate_phase(phase)
    key = f"{video_id}:{_QUALITY}"
    task = asyncio.ensure_future(
        _stream_batch(client, upstream, [video_id] * stage, consume_full=True)
    )
    peak_pending = stream_module._spool_pending_jobs
    original_timeout = stream_module.YTMUSIC_SPOOL_TIMEOUT
    stream_module.YTMUSIC_SPOOL_TIMEOUT = max(original_timeout, 20.0)
    join_target = min(stage, 50)
    try:
        try:
            await _wait_until(
                lambda: stream_module._spool_waiters.get(key, 0) >= join_target or task.done(),
                f"{expected_error} fault listeners joining one spool",
                timeout_seconds=15,
            )
            peak_pending = max(peak_pending, stream_module._spool_pending_jobs)
            joined_waiters = stream_module._spool_waiters.get(key, 0)
        finally:
            gate.set()
        failure_key = stream_module._spool_failure_key(
            video_id,
            _QUALITY,
            "interactive",
            provider_identity=stream_module._SPOOL_PROVIDER_IDENTITY,
        )
        await _wait_until(
            lambda: failure_key in stream_module._spool_failure_cache or task.done(),
            f"{expected_error} fault entering cooldown",
            timeout_seconds=5,
        )
        replay = await _observe_stream(client, upstream, video_id, consume_full=True)
        results = await task
        await _wait_stream_idle(stream_module, upstream)
    finally:
        stream_module.YTMUSIC_SPOOL_TIMEOUT = original_timeout
        if not task.done():
            task.cancel()
            with suppress(asyncio.CancelledError):
                await task
    summary = _summarize(results)
    summary["joinedWaitersAtRelease"] = joined_waiters
    summary["cooldownReplay"] = {
        key: value for key, value in replay.items() if key in {"error", "status"}
    }
    summary["upstreamCalls"] = upstream.stream_call_count(phase)
    return summary, peak_pending


def _attach_wait_metric(
    summary: dict[str, Any], upstream: _DeterministicUpstream, kind: str, keys: Sequence[str]
) -> None:
    waits = upstream.wait_samples(kind, keys)
    if waits:
        summary["latency"]["upstreamStartWaitMs"] = {
            "p50": _quantile(waits, 0.5),
            "p95": _quantile(waits, 0.95),
        }


async def _prefill_streams(
    client: httpx.AsyncClient,
    upstream: _DeterministicUpstream,
    stream_module: Any,
    video_ids: Sequence[str],
    phase: str,
) -> None:
    upstream.set_phase(phase)
    preload_capacity = stream_module._SPOOL_MAX_BACKGROUND_PENDING_JOBS
    for offset in range(0, len(video_ids), preload_capacity):
        chunk = video_ids[offset : offset + preload_capacity]
        results = await _stream_batch(
            client,
            upstream,
            chunk,
            consume_full=True,
            purpose="preload",
        )
        if any(not result.get("ok") for result in results):
            raise AssertionError(f"Bounded workload prefill unexpectedly failed: {results!r}")
        await _wait_stream_idle(stream_module, upstream)


async def _run_stream_stage(
    stage: int,
    client: httpx.AsyncClient,
    upstream: _DeterministicUpstream,
    stream_module: Any,
    ids: _IdSource,
) -> tuple[dict[str, Any], int]:
    max_pending = 0
    stream_module.YTMUSIC_SPOOL_TIMEOUT = 3.0

    same_phase = f"{stage}-stream-same-cold"
    same_id = ids.one()
    same_key = f"{same_id}:{_QUALITY}"
    upstream.set_phase(same_phase)
    same_gate = upstream.gate_phase(same_phase)
    same_pending_peak = 0

    def same_active_leases() -> int:
        nonlocal same_pending_peak
        same_pending_peak = max(same_pending_peak, int(stream_module._spool_pending_jobs))
        return int(stream_module._spool_waiters.get(same_key, 0))

    same_results, same_lease_peak = await _run_gated_tracked(
        _stream_batch(client, upstream, [same_id] * stage, consume_full=True),
        same_active_leases,
        stage,
        same_gate,
    )
    max_pending = max(max_pending, same_pending_peak)
    same = _summarize(same_results)
    same["upstreamCalls"] = upstream.stream_call_count(same_phase)
    same["peakActiveStreamLeases"] = same_lease_peak
    same["peakPendingJobs"] = same_pending_peak
    same["peakProviderWorkers"] = upstream.phase_stream_peak[same_phase]
    _attach_wait_metric(same, upstream, "stream", [same_key])
    await _wait_stream_idle(stream_module, upstream)

    cold_phase = f"{stage}-stream-cold-distinct"
    cold_ids = ids.many(stage)
    upstream.set_phase(cold_phase)
    cold_gate = upstream.gate_phase(cold_phase)
    cold_results, peak = await _run_gated_tracked(
        _stream_batch(client, upstream, cold_ids, consume_full=True),
        lambda: stream_module._spool_pending_jobs,
        min(stage, stream_module._SPOOL_MAX_PENDING_JOBS),
        cold_gate,
    )
    max_pending = max(max_pending, peak)
    cold = _summarize(cold_results)
    cold["upstreamCalls"] = upstream.stream_call_count(cold_phase)
    _attach_wait_metric(cold, upstream, "stream", [f"{item}:{_QUALITY}" for item in cold_ids])
    await _wait_stream_idle(stream_module, upstream)

    warm_ids = ids.many(stage)
    await _prefill_streams(
        client, upstream, stream_module, warm_ids, f"{stage}-stream-warm-prefill"
    )
    warm_phase = f"{stage}-stream-warm"
    upstream.set_phase(warm_phase)
    warm_results, peak = await _run_tracked(
        _stream_batch(client, upstream, warm_ids, consume_full=True),
        lambda: stream_module._spool_pending_jobs,
    )
    max_pending = max(max_pending, peak)
    warm = _summarize(warm_results)
    warm["upstreamCalls"] = upstream.stream_call_count(warm_phase)

    cached_count = stage // 2
    mixed_ids = ids.many(stage)
    await _prefill_streams(
        client,
        upstream,
        stream_module,
        mixed_ids[:cached_count],
        f"{stage}-stream-mixed-prefill",
    )
    mixed_phase = f"{stage}-stream-mixed"
    upstream.set_phase(mixed_phase)
    mixed_gate = upstream.gate_phase(mixed_phase)
    mixed_results, peak = await _run_gated_tracked(
        _stream_batch(client, upstream, mixed_ids, consume_full=True),
        lambda: stream_module._spool_pending_jobs,
        min(stage - cached_count, stream_module._SPOOL_MAX_PENDING_JOBS),
        mixed_gate,
    )
    max_pending = max(max_pending, peak)
    mixed = _summarize(mixed_results)
    mixed["cachedInputs"] = cached_count
    mixed["coldInputs"] = stage - cached_count
    mixed["upstreamCalls"] = upstream.stream_call_count(mixed_phase)
    _attach_wait_metric(mixed, upstream, "stream", [f"{item}:{_QUALITY}" for item in mixed_ids])
    await _wait_stream_idle(stream_module, upstream)

    rapid_phase = f"{stage}-stream-rapid-cancel"
    rapid_id = ids.one()
    upstream.set_stream_mode(rapid_id, "slow")
    upstream.set_phase(rapid_phase)
    rapid_tasks = [
        asyncio.create_task(_observe_stream(client, upstream, rapid_id, consume_full=True))
        for _ in range(stage)
    ]
    rapid_key = f"{rapid_id}:{_QUALITY}"
    await _wait_until(
        lambda: (
            upstream.stream_call_count(rapid_phase) == 1
            and stream_module._spool_waiters.get(rapid_key, 0) > 0
        ),
        "rapid-skip listeners reaching the shared spool",
    )
    await asyncio.sleep(0.02)
    joined_before_cancel = stream_module._spool_waiters.get(rapid_key, 0)
    for task in rapid_tasks:
        task.cancel()
    rapid_results = await asyncio.gather(*rapid_tasks)
    cancelled = sum(result.get("error") == "cancelled" for result in rapid_results)
    await _wait_stream_idle(stream_module, upstream)

    final_phase = f"{stage}-stream-rapid-final"
    final_id = ids.one()
    upstream.set_phase(final_phase)
    final_results, peak = await _run_tracked(
        _stream_batch(client, upstream, [final_id] * stage, consume_full=True),
        lambda: stream_module._spool_pending_jobs,
    )
    max_pending = max(max_pending, peak)
    final = _summarize(final_results)
    final["upstreamCalls"] = upstream.stream_call_count(final_phase)
    await _wait_stream_idle(stream_module, upstream)

    unavailable_phase = f"{stage}-stream-unavailable"
    unavailable_id = ids.one()
    upstream.set_stream_mode(unavailable_id, "unavailable")
    unavailable, peak = await _run_stream_fault_wave(
        stage,
        client,
        upstream,
        stream_module,
        phase=unavailable_phase,
        video_id=unavailable_id,
        expected_error="unavailable",
    )
    max_pending = max(max_pending, peak)

    timeout_phase = f"{stage}-stream-timeout"
    timeout_id = ids.one()
    upstream.set_stream_mode(timeout_id, "timeout")
    timeout, peak = await _run_stream_fault_wave(
        stage,
        client,
        upstream,
        stream_module,
        phase=timeout_phase,
        video_id=timeout_id,
        expected_error="timeout",
    )
    max_pending = max(max_pending, peak)

    return (
        {
            "sameTrackCold": same,
            "coldDistinct": cold,
            "warmDistinct": warm,
            "mixedCachedCold": mixed,
            "rapidSkip": {
                "cancelled": cancelled,
                "joinedWaitersBeforeCancel": joined_before_cancel,
                "upstreamCallsBeforeCancel": upstream.stream_call_count(rapid_phase),
                "final": final,
            },
            "faults": {"unavailable": unavailable, "timeout": timeout},
            "runtime": {
                "failureCacheEntries": len(stream_module._spool_failure_cache),
            },
        },
        max_pending,
    )


async def _run_search_stage(
    stage: int,
    client: httpx.AsyncClient,
    upstream: _DeterministicUpstream,
    search_module: Any,
) -> tuple[dict[str, Any], int]:
    max_jobs = 0
    query = f"sidecar same query {stage}"
    cold_phase = f"{stage}-search-same-cold"
    upstream.set_phase(cold_phase)
    cold_results, peak = await _run_tracked(
        asyncio.gather(*(_observe_search(client, upstream, query) for _ in range(stage))),
        lambda: len(search_module._search_provider_jobs),
    )
    max_jobs = max(max_jobs, peak)
    cold = _summarize(cold_results)
    cold["upstreamCalls"] = upstream.search_call_count(cold_phase)
    _attach_wait_metric(cold, upstream, "search", [query])
    await _wait_until(lambda: not search_module._search_provider_jobs, "search singleflight idle")

    warm_phase = f"{stage}-search-same-warm"
    upstream.set_phase(warm_phase)
    warm_results, peak = await _run_tracked(
        asyncio.gather(*(_observe_search(client, upstream, query) for _ in range(stage))),
        lambda: len(search_module._search_provider_jobs),
    )
    max_jobs = max(max_jobs, peak)
    warm = _summarize(warm_results)
    warm["upstreamCalls"] = upstream.search_call_count(warm_phase)

    batch_query = f"sidecar batch query {stage}"
    batch_phase = f"{stage}-search-batch"
    upstream.set_phase(batch_phase)
    upstream.record_client_start("search", batch_query, time.perf_counter())
    partitions = [
        [
            {"query": batch_query, "filter": "songs", "limit": 5}
            for _ in range(min(50, stage - offset))
        ]
        for offset in range(0, stage, 50)
    ]

    async def run_batch() -> list[dict[str, Any]]:
        responses = await asyncio.gather(
            *(
                client.post(
                    "/search/batch",
                    params={"user_id": "load-user"},
                    json={"queries": partition},
                )
                for partition in partitions
            )
        )
        return [
            {"ok": response.status_code == 200, "status": response.status_code}
            for response in responses
        ]

    batch_responses, peak = await _run_tracked(
        run_batch(), lambda: len(search_module._search_provider_jobs)
    )
    max_jobs = max(max_jobs, peak)
    if any(not item["ok"] for item in batch_responses):
        raise AssertionError("Batch search workload failed at the HTTP boundary")
    batch_rows = sum(len(partition) for partition in partitions)
    batch = {
        "requests": len(partitions),
        "rows": batch_rows,
        "upstreamCalls": upstream.search_call_count(batch_phase),
    }
    await _wait_until(lambda: not search_module._search_provider_jobs, "batch search idle")

    mixed_phase = f"{stage}-search-mixed"
    upstream.set_phase(mixed_phase)
    cold_queries = [f"sidecar mixed cold {stage} {index}" for index in range(stage // 2)]
    mixed_queries = [query] * (stage - len(cold_queries)) + cold_queries
    mixed_gate = upstream.gate_phase(mixed_phase)
    mixed_results, peak = await _run_gated_tracked(
        asyncio.gather(*(_observe_search(client, upstream, item) for item in mixed_queries)),
        lambda: len(search_module._search_provider_jobs),
        min(len(cold_queries), search_module.SEARCH_PROVIDER_CONCURRENCY),
        mixed_gate,
    )
    max_jobs = max(max_jobs, peak)
    mixed = _summarize(mixed_results)
    mixed["cachedInputs"] = stage - len(cold_queries)
    mixed["coldInputs"] = len(cold_queries)
    mixed["upstreamCalls"] = upstream.search_call_count(mixed_phase)
    _attach_wait_metric(mixed, upstream, "search", cold_queries)
    await _wait_until(lambda: not search_module._search_provider_jobs, "mixed search idle")

    return (
        {
            "sameQueryCold": cold,
            "sameQueryWarm": warm,
            "batchSameQuery": batch,
            "mixedCachedCold": mixed,
            "runtime": {
                "cacheEntries": len(search_module._search_cache),
                "providerJobs": len(search_module._search_provider_jobs),
            },
        },
        max_jobs,
    )


async def _tail_stats(tail_module: Any) -> dict[str, int]:
    stats = getattr(tail_module._tail_warmup, "stats", None)
    if stats is None:
        raise RuntimeError("TailWarmupCoordinator.stats() is required by the bounded workload")
    return dict(await stats())


async def _run_tail_stage(
    stage: int,
    client: httpx.AsyncClient,
    upstream: _DeterministicUpstream,
    tail_module: Any,
    ids: _IdSource,
) -> tuple[dict[str, Any], int]:
    stream_module: Any = importlib.import_module("ytmusic_stream")

    stream_module.YTMUSIC_SPOOL_TIMEOUT = 3.0
    cancelled_before = upstream.cancelled_stream_calls
    old_ids = ids.many(4)
    new_ids = ids.many(4)
    for video_id in old_ids:
        upstream.set_stream_mode(video_id, "slow")
    old_phase = f"{stage}-tail-old-generation"
    upstream.set_phase(old_phase)
    old_generation_gate = upstream.gate_phase(old_phase)
    tail_request_samples: list[dict[str, Any]] = []

    async def reconcile(owner: int, generation: int, plan: Sequence[str]) -> httpx.Response:
        started = time.perf_counter()
        response = await client.post(
            "/tail-warmup/reconcile",
            json={
                "ownerId": f"load-{stage}-{owner}",
                "generation": generation,
                "quality": _QUALITY,
                "current": plan[0],
                "immediate": plan[1],
                "tail": list(plan[2:]),
            },
        )
        tail_request_samples.append(
            {
                "ok": response.status_code == 200,
                "status": response.status_code,
                "error": (
                    None if response.status_code == 200 else _classify_status(response.status_code)
                ),
                "requestMs": _round((time.perf_counter() - started) * 1000),
            }
        )
        return response

    first = await asyncio.gather(*(reconcile(owner, 1, old_ids) for owner in range(stage)))
    if any(response.status_code != 200 for response in first):
        raise AssertionError("Initial tail generation was not accepted")
    await _wait_until(
        lambda: upstream.transfer_call_count(old_phase) >= 1,
        "old tail generation transfer starting",
    )
    before_replace = await _tail_stats(tail_module)

    new_phase = f"{stage}-tail-new-generation"
    upstream.set_phase(new_phase)
    second = await asyncio.gather(*(reconcile(owner, 2, new_ids) for owner in range(stage)))
    old_generation_gate.set()
    if any(response.status_code != 200 for response in second):
        raise AssertionError("Replacement tail generation was not accepted")

    peak_jobs = before_replace["jobs"]
    peak_active_jobs = before_replace["activeJobs"]
    deadline = time.monotonic() + 5
    while True:
        stats = await _tail_stats(tail_module)
        peak_jobs = max(peak_jobs, stats["jobs"])
        peak_active_jobs = max(peak_active_jobs, stats["activeJobs"])
        if stats["activeJobs"] == 0 and stats["queuedJobs"] == 0:
            break
        if time.monotonic() >= deadline:
            raise TimeoutError("Tail replacement generation did not drain")
        await asyncio.sleep(0.003)

    final = await asyncio.gather(*(reconcile(owner, 3, new_ids) for owner in range(stage)))
    if any(response.status_code != 200 for response in final):
        raise AssertionError("Final tail status snapshot failed")
    statuses = Counter(
        item["status"] for response in final for item in response.json().get("items", [])
    )
    runtime = await _tail_stats(tail_module)
    max_response_bytes = max(len(response.content) for response in (*first, *second, *final))
    cleared = await asyncio.gather(
        *(
            client.post(
                "/tail-warmup/reconcile",
                json={
                    "ownerId": f"load-{stage}-{owner}",
                    "generation": 4,
                    "quality": _QUALITY,
                    "current": None,
                    "immediate": None,
                    "tail": [],
                },
            )
            for owner in range(stage)
        )
    )
    if any(response.status_code != 200 for response in cleared):
        raise AssertionError("Tail workload cleanup generation was not accepted")
    return (
        {
            "generationReplaced": upstream.cancelled_stream_calls > cancelled_before,
            "oldGenerationUpstreamCalls": upstream.stream_call_count(old_phase),
            "newGenerationUpstreamCalls": upstream.stream_call_count(new_phase),
            "finalStatuses": dict(sorted(statuses.items())),
            "maxStatusResponseBytes": max_response_bytes,
            "http": _summarize(tail_request_samples),
            "peakUpstreamWork": upstream.phase_stream_peak[new_phase],
            "peakActiveJobs": peak_active_jobs,
            "runtime": runtime,
            "bounds": {
                "concurrency": tail_module.TAIL_WARMUP_CONCURRENCY,
                "providerConcurrency": stream_module.YTDLP_EXTRACT_CONCURRENCY,
                "capacity": tail_module.TAIL_WARMUP_CAPACITY,
                "ownerCapacity": tail_module.TAIL_WARMUP_OWNER_CAPACITY,
            },
        },
        peak_jobs,
    )


def _validate_stages(stages: Sequence[int]) -> tuple[int, ...]:
    normalized = tuple(stages)
    if not normalized:
        raise ValueError("At least one listener stage is required")
    if any(not isinstance(stage, int) or isinstance(stage, bool) for stage in normalized):
        raise TypeError("Listener stages must be integers")
    if any(stage < 1 or stage > MAX_STAGE for stage in normalized):
        raise ValueError(f"Listener stages must be between 1 and {MAX_STAGE}")
    return normalized


async def run_sidecar_workload(
    *,
    stages: Sequence[int] = DEFAULT_STAGES,
    spool_directory: Path | None = None,
) -> dict[str, Any]:
    """Exercise local sidecar capacity without any provider or production I/O."""
    normalized_stages = _validate_stages(stages)
    service_root = _REPOSITORY_ROOT / "services" / "ytmusic-streamer"
    if str(service_root) not in sys.path:
        sys.path.insert(0, str(service_root))
    if str(_REPOSITORY_ROOT) not in sys.path:
        sys.path.insert(0, str(_REPOSITORY_ROOT))
    os.environ["INTERNAL_API_SECRET"] = _INTERNAL_SECRET

    app_module: Any = importlib.import_module("app")
    search_module: Any = importlib.import_module("ytmusic_search")
    stream_module: Any = importlib.import_module("ytmusic_stream")
    tail_module: Any = importlib.import_module("ytmusic_tail_warmup")

    temporary: tempfile.TemporaryDirectory[str] | None = None
    if spool_directory is None:
        temporary = tempfile.TemporaryDirectory(prefix="soundspan-sidecar-load-")
        spool_directory = Path(temporary.name)
    spool_directory.mkdir(parents=True, exist_ok=True)

    upstream = _DeterministicUpstream(stream_module, spool_directory)
    original_stream_info_provider = stream_module._get_stream_url_sync
    original_stream_response = stream_module.requests.get
    original_search_provider = search_module._search_with_mode_fallback
    original_spool_directory = stream_module.YTMUSIC_SPOOL_DIR
    original_spool_timeout = stream_module.YTMUSIC_SPOOL_TIMEOUT
    stream_module._get_stream_url_sync = upstream.stream_info_provider
    stream_module.requests.get = upstream.stream_response
    search_module._search_with_mode_fallback = upstream.search_provider
    stream_module.YTMUSIC_SPOOL_DIR = spool_directory
    stream_module.YTMUSIC_SPOOL_TIMEOUT = 0.15

    ids = _IdSource()
    stage_reports: list[dict[str, Any]] = []
    max_spool_pending = 0
    max_search_jobs = 0
    max_tail_jobs = 0
    max_search_cache_entries = 0
    max_spool_failure_cache_entries = 0
    max_retained_spool_files = 0
    max_retained_spool_bytes = 0
    httpx_logger = logging.getLogger("httpx")
    previous_httpx_log_level = httpx_logger.level
    httpx_logger.setLevel(logging.WARNING)
    asyncio_logger = logging.getLogger("asyncio")
    previous_asyncio_log_level = asyncio_logger.level
    asyncio_logger.setLevel(logging.CRITICAL)
    sidecar_logger = logging.getLogger("ytmusic-streamer")
    previous_sidecar_log_level = sidecar_logger.level
    sidecar_logger.setLevel(logging.CRITICAL)
    keepalive_transport: dict[str, Any] | None = None
    try:
        async with _LocalServer(app_module.app, max(normalized_stages)) as local:
            if local.client is None:
                raise RuntimeError("Local sidecar client was not initialized")
            for stage in normalized_stages:
                search, search_jobs = await _run_search_stage(
                    stage, local.client, upstream, search_module
                )
                tail, tail_jobs = await _run_tail_stage(
                    stage, local.client, upstream, tail_module, ids
                )
                tail_spool = upstream.cleanup_generated_spool()
                tail["retainedSpool"] = tail_spool
                stream, spool_pending = await _run_stream_stage(
                    stage, local.client, upstream, stream_module, ids
                )
                stream_spool = upstream.cleanup_generated_spool()
                stream["retainedSpool"] = stream_spool
                max_retained_spool_files = max(
                    max_retained_spool_files,
                    tail_spool["files"],
                    stream_spool["files"],
                )
                max_retained_spool_bytes = max(
                    max_retained_spool_bytes,
                    tail_spool["bytes"],
                    stream_spool["bytes"],
                )
                max_spool_pending = max(max_spool_pending, spool_pending)
                max_search_jobs = max(max_search_jobs, search_jobs)
                max_tail_jobs = max(max_tail_jobs, tail_jobs)
                max_search_cache_entries = max(
                    max_search_cache_entries,
                    search["runtime"]["cacheEntries"],
                )
                max_spool_failure_cache_entries = max(
                    max_spool_failure_cache_entries,
                    stream["runtime"]["failureCacheEntries"],
                )
                stage_reports.append(
                    {"listeners": stage, "search": search, "stream": stream, "tail": tail}
                )
            keepalive_transport = await _run_keepalive_transport_profile(
                max(normalized_stages),
                local,
                upstream,
            )

        final_tail = await _tail_stats(tail_module)
        stream_module._clean_spool_failure_cache()
        max_search_cache_entries = max(
            max_search_cache_entries,
            len(search_module._search_cache),
        )
        spool_files = [path for path in spool_directory.iterdir() if path.is_file()]
        if keepalive_transport is None:
            raise RuntimeError("Keepalive transport profile did not run")
        report: dict[str, Any] = {
            "mode": "local-sidecar-deterministic-upstream",
            "disclaimer": (
                "This measures real local sidecar control flow with deterministic fake upstream "
                "work. It is not a YouTube, browser-decoder, network, or production SLO."
            ),
            "providerNetworkRequests": 0,
            "listenerStages": list(normalized_stages),
            "measurementDefinitions": {
                "searchRequestMs": "Local TCP request start through parsed search JSON.",
                "serverReadyMs": (
                    "Local TCP stream start through response headers after the sidecar proved a "
                    "growing prefix or found a completed spool."
                ),
                "firstByteMs": "Local TCP stream start through the first non-empty media body chunk.",
                "upstreamStartWaitMs": (
                    "Client request start through deterministic upstream work starting; includes "
                    "loopback dispatch, preflight, admission, and queue wait."
                ),
                "audibleMs": {
                    "measured": False,
                    "reason": (
                        "Audible playback requires browser media decoding and an output event; "
                        "the server cannot infer it from first byte."
                    ),
                },
            },
            "transportProfiles": {
                "freshTcpFanout": {
                    "keepAliveEnabled": False,
                    "reason": (
                        "The shared load client opens fresh TCP connections so independent "
                        "listeners do not inherit one synthetic cross-user idle pool."
                    ),
                },
                "perListenerKeepAlive": keepalive_transport,
            },
            "stages": stage_reports,
            "observedBounds": {
                "streamProviderPeak": upstream.stream_peak,
                "streamProviderLimit": stream_module.YTDLP_EXTRACT_CONCURRENCY,
                "streamTransferPeak": upstream.transfer_peak,
                "streamTransferLimit": stream_module.YTMUSIC_SPOOL_CONCURRENCY,
                "searchProviderPeak": upstream.search_peak,
                "searchProviderLimit": search_module.SEARCH_PROVIDER_CONCURRENCY,
                "maxSpoolPending": max_spool_pending,
                "spoolPendingLimit": stream_module._SPOOL_MAX_PENDING_JOBS,
                "maxSearchJobs": max_search_jobs,
                "maxTailJobs": max_tail_jobs,
                "tailCapacity": tail_module.TAIL_WARMUP_CAPACITY,
                "tailOwners": final_tail["owners"],
                "tailOwnerCapacity": tail_module.TAIL_WARMUP_OWNER_CAPACITY,
                "spoolFiles": len(spool_files),
                "spoolBytes": sum(path.stat().st_size for path in spool_files),
                "maxRetainedSpoolFiles": max_retained_spool_files,
                "maxRetainedSpoolBytes": max_retained_spool_bytes,
                "maxSpoolReservedBytes": upstream.spool_reserved_peak,
                "spoolByteLimit": stream_module.YTMUSIC_SPOOL_MAX_BYTES,
                "spoolFailureCacheEntries": len(stream_module._spool_failure_cache),
                "maxSpoolFailureCacheEntries": max_spool_failure_cache_entries,
                "spoolFailureCacheLimit": stream_module._SPOOL_FAILURE_CACHE_MAX,
                "searchCacheEntries": len(search_module._search_cache),
                "maxSearchCacheEntries": max_search_cache_entries,
                "searchCacheLimit": search_module.SEARCH_CACHE_MAX,
                "tailInterests": final_tail["interests"],
                "tailVersions": final_tail["versions"],
            },
        }
        issues = _acceptance_issues(report)
        report["acceptance"] = {"passed": not issues, "issues": issues}
        return report
    finally:
        with suppress(Exception):
            await tail_module.shutdown_tail_warmup()
        with suppress(Exception):
            await stream_module.shutdown_stream_provider()
        with suppress(Exception):
            await search_module.shutdown_search_provider()
        stream_module._get_stream_url_sync = original_stream_info_provider
        stream_module.requests.get = original_stream_response
        search_module._search_with_mode_fallback = original_search_provider
        stream_module.YTMUSIC_SPOOL_DIR = original_spool_directory
        stream_module.YTMUSIC_SPOOL_TIMEOUT = original_spool_timeout
        httpx_logger.setLevel(previous_httpx_log_level)
        if temporary is not None:
            temporary.cleanup()
        asyncio_logger.setLevel(previous_asyncio_log_level)
        sidecar_logger.setLevel(previous_sidecar_log_level)


def _parse_stages(value: str) -> tuple[int, ...]:
    try:
        return tuple(int(item.strip()) for item in value.split(",") if item.strip())
    except ValueError as error:
        raise argparse.ArgumentTypeError("stages must be comma-separated integers") from error


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--stages",
        type=_parse_stages,
        default=DEFAULT_STAGES,
        help="comma-separated concurrent listener stages (default: 20,50,100,120)",
    )
    parser.add_argument("--output", type=Path, help="optional JSON report path")
    args = parser.parse_args()
    try:
        report = asyncio.run(run_sidecar_workload(stages=args.stages))
    except (AssertionError, RuntimeError, TimeoutError, TypeError, ValueError) as error:
        sys.stderr.write(f"Sidecar workload failed: {error}\n")
        return 1
    rendered = json.dumps(report, ensure_ascii=False, indent=2) + "\n"
    if args.output is None:
        sys.stdout.write(rendered)
    else:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(rendered, encoding="utf-8")
        sys.stdout.write(f"Wrote local sidecar workload report to {args.output}\n")
    return 0 if report["acceptance"]["passed"] else 2


if __name__ == "__main__":
    raise SystemExit(main())
