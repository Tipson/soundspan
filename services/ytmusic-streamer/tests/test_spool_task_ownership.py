"""Request waiters must not re-log or cancel registry-owned spool outcomes."""

import asyncio
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from types import SimpleNamespace
from typing import Any, Literal, cast

import pytest
from fastapi import HTTPException, Request
from yt_dlp.utils import DownloadError


@pytest.fixture()
def actual_spool_downloader(monkeypatch: pytest.MonkeyPatch) -> Any:
    """Fake only metadata/clock while exercising real yt-dlp HTTP, errors and hooks."""
    import yt_dlp
    from yt_dlp.extractor.common import InfoExtractor
    from yt_dlp.utils import ExtractorError

    real_downloader = yt_dlp.YoutubeDL
    state = SimpleNamespace(
        status=200,
        metadata_at=0.0,
        body_at=0.0,
        offset=0.0,
        entered=threading.Event(),
        release=threading.Event(),
        events=[],
        recovery="ordinary",
    )

    class Handler(BaseHTTPRequestHandler):
        def do_GET(self) -> None:
            state.events.append(("GET", state.offset))
            self.send_response(state.status)
            self.send_header("Content-Type", "audio/webm")
            self.send_header("Content-Length", "64")
            self.end_headers()
            if state.status == 200:
                self.wfile.write(b"x" * 64)

        def log_message(self, *_args: Any) -> None:
            pass

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    server_thread = threading.Thread(target=server.serve_forever, daemon=True)
    server_thread.start()
    local_url = f"http://127.0.0.1:{server.server_port}/audio.webm"

    class LocalYoutubeIE(InfoExtractor):  # type: ignore[misc,no-any-unimported]  # Upstream is untyped.
        IE_NAME = "youtube"
        _VALID_URL = r"https://music\.youtube\.com/watch\?v=(?P<id>[A-Za-z0-9_-]{11})"

        def _real_extract(self, url: str) -> dict[str, Any]:
            options = self._downloader.params
            if state.recovery == "javascript" and not options.get("js_runtimes"):
                raise ExtractorError("Requested format is not available", expected=True)
            if state.recovery == "po" and options["extractor_args"]["youtube"].get(
                "player_client"
            ) != ["mweb"]:
                raise ExtractorError("Sign in to confirm you're not a bot", expected=True)
            state.offset = state.metadata_at
            state.events.append(("metadata", state.offset))
            return {
                "id": self._match_id(url),
                "title": "Loopback transfer fixture",
                "url": local_url,
                "ext": "webm",
                "acodec": "opus",
                "vcodec": "none",
                "duration": 1,
            }

    def factory(options: dict[str, Any]) -> Any:
        hooks = options.get("progress_hooks", [])

        def progress(status: dict[str, Any]) -> None:
            state.events.append((status["status"], state.offset))
            for hook in hooks:
                hook(status)

        downloader = real_downloader(
            {
                **options,
                "progress_hooks": [progress],
                "retries": 0,
                "cachedir": False,
                "fixup": "never",
            },
            auto_init=False,
        )
        downloader.add_info_extractor(LocalYoutubeIE())
        original_open = downloader.urlopen

        def urlopen(request: Any) -> Any:
            response = original_open(request)
            state.events.append(("headers", state.offset))
            original_read = response.read

            def read(*args: Any, **kwargs: Any) -> bytes:
                state.entered.set()
                if not state.release.wait(timeout=3):
                    raise TimeoutError("loopback reader was not released")
                result = cast(bytes, original_read(*args, **kwargs))
                state.offset = state.body_at
                return result

            response.read = read
            return response

        downloader.urlopen = urlopen
        return downloader

    monkeypatch.setattr(yt_dlp, "YoutubeDL", factory)
    try:
        yield state
    finally:
        state.release.set()
        server.shutdown()
        server.server_close()
        server_thread.join(timeout=2)


@pytest.mark.anyio
@pytest.mark.parametrize("recovery", ["ordinary", "javascript", "po"])
async def test_shared_actual_downloader_acquires_before_first_body_progress(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path, actual_spool_downloader: Any, recovery: str
) -> None:
    """Headers at 100s and first body/progress at 115s stay within transfer limits."""
    import ytmusic_js_fallback as fallback
    import ytmusic_po_fallback as po
    import ytmusic_stream as stream

    state = actual_spool_downloader
    state.metadata_at = 100.0
    state.body_at = 115.0
    state.recovery = recovery

    def now() -> float:
        return time.monotonic() + cast(float, state.offset)

    monkeypatch.setattr(stream, "time", SimpleNamespace(**{**vars(time), "monotonic": now}))
    monkeypatch.setattr(fallback, "time", SimpleNamespace(monotonic=now))
    monkeypatch.setattr(fallback, "JS_CLIENT_FALLBACK_ENABLED", recovery == "javascript")
    monkeypatch.setattr(po, "provider_available", lambda: recovery == "po")
    monkeypatch.setattr(stream, "YTMUSIC_SPOOL_DIR", tmp_path)
    monkeypatch.setattr(stream, "_resolve_progressive_spool_plan_sync", lambda *_args: None)
    monkeypatch.setattr(stream, "_wait_for_provider", lambda *_args: None)
    video = "dQw4w9WgXcQ"
    key = f"{video}:HIGH"

    class ConnectedRequest:
        async def is_disconnected(self) -> bool:
            return False

    task = stream._create_spool_task(key, video, "HIGH")
    session = stream._spool_sessions[key]
    first = stream._SpoolLease(key, task, session.cancel_event, session)
    second = None
    try:
        assert await asyncio.to_thread(state.entered.wait, 2)
        second_deadline = now() + stream.YTMUSIC_SPOOL_TIMEOUT
        second = asyncio.create_task(
            stream._await_spool_task_for_request(
                key, task, cast(Request, ConnectedRequest()), deadline=second_deadline
            )
        )
        await asyncio.sleep(0)
        assert session.lease_count == 2
        state.offset = 115.0
        first.close()
        assert not session.cancel_event.is_set()
        assert stream._extraction_budget._active == 1
        state.release.set()
        completed, content_type = await asyncio.wait_for(second, 3)
        assert await asyncio.to_thread(Path(completed).read_bytes) == b"x" * 64
        assert content_type == "audio/webm"
        assert ("headers", 100.0) in state.events
        assert ("downloading", 115.0) in state.events
        assert sum(event == "GET" for event, _ in state.events) == 1
    finally:
        state.release.set()
        first.close()
        await asyncio.gather(task, return_exceptions=True)
        if second is not None:
            await asyncio.gather(second, return_exceptions=True)


@pytest.mark.parametrize("recovery", ["ordinary", "javascript", "po"])
def test_actual_late_metadata_does_not_start_any_transfer(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path, actual_spool_downloader: Any, recovery: str
) -> None:
    """The actual before_dl boundary still rejects metadata finishing after acquisition."""
    import ytmusic_js_fallback as fallback
    import ytmusic_po_fallback as po
    import ytmusic_stream as stream
    from ytmusic_extraction_budget import ExtractionAbandoned

    state = actual_spool_downloader
    state.metadata_at = 111.0
    state.body_at = 115.0
    state.recovery = recovery
    state.release.set()

    def now() -> float:
        return time.monotonic() + cast(float, state.offset)

    monkeypatch.setattr(stream, "time", SimpleNamespace(**{**vars(time), "monotonic": now}))
    monkeypatch.setattr(fallback, "time", SimpleNamespace(monotonic=now))
    monkeypatch.setattr(fallback, "JS_CLIENT_FALLBACK_ENABLED", recovery == "javascript")
    monkeypatch.setattr(po, "provider_available", lambda: recovery == "po")
    monkeypatch.setattr(stream, "YTMUSIC_SPOOL_DIR", tmp_path)
    monkeypatch.setattr(stream, "_wait_for_provider", lambda *_args: None)
    phase = stream._SpoolTransferPhase(now() + 110.0, threading.Event())
    monkeypatch.setattr(
        stream._spool_worker_context, "deadline", phase.acquisition_deadline, raising=False
    )
    monkeypatch.setattr(stream._spool_worker_context, "transfer_phase", phase, raising=False)
    options = stream._build_ytmusic_spool_options(
        "dQw4w9WgXcQ",
        "HIGH",
        match_filter=lambda *_args, **_kwargs: None,
        progress_hook=stream._build_spool_progress_hook(now(), threading.Event()),
    )
    with pytest.raises(ExtractionAbandoned):
        stream._extract_spool_with_retry("dQw4w9WgXcQ", options, threading.Event())
    assert not phase.started.is_set()
    assert all(event != "GET" for event, _ in state.events)


@pytest.mark.parametrize("status", [404, 503, 429])
def test_actual_terminal_download_error_does_not_enter_js_recovery(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path, actual_spool_downloader: Any, status: int
) -> None:
    """Actual yt-dlp typed/flattened HTTP failures must not repeat a terminal GET."""
    import ytmusic_js_fallback as fallback
    import ytmusic_stream as stream

    state = actual_spool_downloader
    state.status = status
    state.release.set()
    monkeypatch.setattr(fallback, "JS_CLIENT_FALLBACK_ENABLED", True)
    monkeypatch.setattr(stream, "YTMUSIC_SPOOL_DIR", tmp_path)
    monkeypatch.setattr(stream, "_wait_for_provider", lambda *_args: None)
    options = stream._build_ytmusic_spool_options(
        "dQw4w9WgXcQ",
        "HIGH",
        match_filter=lambda *_args, **_kwargs: None,
        progress_hook=lambda _status: None,
    )
    with pytest.raises(DownloadError):
        stream._extract_spool_with_retry("dQw4w9WgXcQ", options, threading.Event())
    assert sum(event == "GET" for event, _ in state.events) == 1


@pytest.mark.anyio
@pytest.mark.parametrize("abandonment", ["timeout", "cancel"])
async def test_abandoned_spool_waiter_does_not_relog_owned_failure(abandonment: str) -> None:
    """The writer and its error owner survive a cancelled or expired request waiter."""
    import ytmusic_stream as stream

    loop = asyncio.get_running_loop()
    started = asyncio.Event()
    release = asyncio.Event()
    failure = RuntimeError("owned late spool failure")
    contexts: list[dict[str, Any]] = []
    original_handler = loop.get_exception_handler()

    def record_exception(loop: asyncio.AbstractEventLoop, context: dict[str, Any]) -> None:
        contexts.append(context)
        if original_handler is None:
            loop.default_exception_handler(context)
        else:
            original_handler(loop, context)

    async def writer() -> tuple[str, str]:
        started.set()
        await release.wait()
        raise failure

    owned = asyncio.create_task(writer())
    owned.add_done_callback(
        lambda completed: None if completed.cancelled() else completed.exception()
    )
    loop.set_exception_handler(record_exception)
    waiter = asyncio.create_task(stream._await_spool_task(owned, deadline=time.monotonic() + 0.05))
    try:
        await started.wait()
        if abandonment == "cancel":
            waiter.cancel()
            with pytest.raises(asyncio.CancelledError):
                await waiter
        else:
            with pytest.raises(HTTPException) as expired:
                await waiter
            assert expired.value.status_code == 504
        assert not owned.done()
        release.set()
        outcomes = await asyncio.gather(owned, return_exceptions=True)
        assert len(outcomes) == 1
        assert outcomes[0] is failure
        ready = asyncio.Event()
        loop.call_soon(ready.set)
        await ready.wait()
        assert contexts == []
    finally:
        release.set()
        if not waiter.done():
            waiter.cancel()
        await asyncio.gather(waiter, owned, return_exceptions=True)
        loop.set_exception_handler(original_handler)


@pytest.mark.anyio
async def test_owned_spool_failure_reaches_active_waiter() -> None:
    """The proxy preserves the actual writer exception for a caller still waiting."""
    import ytmusic_stream as stream

    failure = RuntimeError("active spool failure")

    async def writer() -> tuple[str, str]:
        raise failure

    owned = asyncio.create_task(writer())
    with pytest.raises(RuntimeError) as received:
        await stream._await_spool_task(owned)
    assert received.value is failure


@pytest.mark.anyio
@pytest.mark.parametrize("transfer_result", ["completed", "retry-after-deadline", "late-start"])
async def test_coalesced_spool_separates_acquisition_and_transfer_lifetimes(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path, transfer_result: str
) -> None:
    """A late lease may consume completed transfer but cannot extend acquisition/retries."""
    import yt_dlp
    import ytmusic_js_fallback as fallback
    import ytmusic_stream as stream

    video = "dQw4w9WgXcQ"
    key = f"{video}:HIGH"
    completed = tmp_path / f"{video}-HIGH.webm"
    entered = threading.Event()
    release = threading.Event()
    offset = [0.0]
    progress_events = []
    attempts = []

    def now() -> float:
        return time.monotonic() + offset[0]

    monkeypatch.setattr(stream, "time", SimpleNamespace(**{**vars(time), "monotonic": now}))
    monkeypatch.setattr(stream, "YTMUSIC_SPOOL_DIR", tmp_path)
    monkeypatch.setattr(stream, "_resolve_progressive_spool_plan_sync", lambda *_args: None)
    monkeypatch.setattr(stream, "_materialize_progressive_spool_sync", lambda *_args: None)
    monkeypatch.setattr(stream, "_wait_for_provider", lambda *_args: None)
    monkeypatch.setattr(stream, "_raise_if_provider_challenge_cooldown", lambda *_args: None)
    monkeypatch.setattr(fallback, "JS_CLIENT_FALLBACK_ENABLED", transfer_result != "completed")

    class Extractor:
        def __init__(self, options: dict[str, Any]) -> None:
            self.options = options
            self.before_download: list[Any] = []

        def add_post_processor(self, processor: Any, *, when: str) -> None:
            assert when == "before_dl"
            self.before_download.append(processor)

        def __enter__(self) -> Any:
            return self

        def __exit__(self, *_args: Any) -> Literal[False]:
            return False

        def extract_info(self, _url: str, *, download: bool) -> dict[str, Any]:
            assert download
            attempts.append(self.options)
            if transfer_result != "late-start":
                for processor in self.before_download:
                    processor.run({})
                for hook in self.options.get("progress_hooks", []):
                    hook({"status": "downloading", "downloaded_bytes": 0})
                progress_events.append("downloading")
            entered.set()
            if not release.wait(timeout=2):
                raise TimeoutError("test transfer was not released")
            if transfer_result == "late-start":
                for processor in self.before_download:
                    processor.run({})
                for hook in self.options.get("progress_hooks", []):
                    hook({"status": "downloading", "downloaded_bytes": 0})
            if transfer_result == "retry-after-deadline":
                raise DownloadError("Requested format is not available")
            for hook in self.options.get("progress_hooks", []):
                hook({"status": "downloading", "downloaded_bytes": 32})
            progress_events.append("downloading")
            for hook in self.options.get("progress_hooks", []):
                hook({"status": "finished", "downloaded_bytes": 64})
            progress_events.append("finished")
            completed.write_bytes(b"x" * 64)
            return {"id": video, "ext": "webm", "url": "https://audio.invalid/test"}

    class ConnectedRequest:
        async def is_disconnected(self) -> bool:
            return False

    monkeypatch.setattr(yt_dlp, "YoutubeDL", Extractor)
    task = stream._create_spool_task(key, video, "HIGH")
    session = stream._spool_sessions[key]
    first = stream._SpoolLease(key, task, session.cancel_event, session)
    second = None
    try:
        assert await asyncio.to_thread(entered.wait, 1)
        offset[0] = 100.0
        second_deadline = now() + stream.YTMUSIC_SPOOL_TIMEOUT
        second = asyncio.create_task(
            stream._await_spool_task_for_request(
                key, task, cast(Request, ConnectedRequest()), deadline=second_deadline
            )
        )
        await asyncio.sleep(0)
        assert session.lease_count == 2
        offset[0] = 150.0
        first.close()
        assert session.lease_count == 1
        assert not session.cancel_event.is_set()
        assert second_deadline > now()
        release.set()
        if transfer_result == "completed":
            result = await asyncio.wait_for(second, 2)
            assert result == (str(completed), "audio/webm")
            assert completed.stat().st_size == 64
            assert progress_events == ["downloading", "downloading", "finished"]
        else:
            with pytest.raises(HTTPException):
                await asyncio.wait_for(second, 2)
            assert not completed.exists()
        assert len(attempts) == 1
    finally:
        release.set()
        first.close()
        await asyncio.gather(task, return_exceptions=True)
        if second is not None:
            await asyncio.gather(second, return_exceptions=True)
