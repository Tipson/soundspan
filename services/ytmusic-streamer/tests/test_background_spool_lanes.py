"""Background audio transfers must release scarce provider extraction slots."""

import asyncio
import threading
from collections.abc import Callable, Iterator
from pathlib import Path
from typing import Any

import pytest


@pytest.mark.anyio
@pytest.mark.parametrize("priority", [0, 1])
async def test_background_direct_transfer_releases_extraction_lane(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path, priority: int
) -> None:
    import ytmusic_stream as stream

    active: list[str] = []
    calls: list[str] = []
    cancel = threading.Event()
    session = stream._SpoolSession(
        "dQw4w9WgXcQ:MEDIUM",
        asyncio.get_running_loop(),
        cancel,
        allow_growing=False,
        priority=priority,
    )

    class Budget:
        def __init__(self, lane: str) -> None:
            self.lane = lane

        def run(self, operation: Callable[[], Any], **kwargs: Any) -> Any:
            assert not active, "Transfer retained extraction capacity"
            assert kwargs["cancel_event"] is cancel
            assert kwargs["priority"]() == priority
            active.append(self.lane)
            calls.append(self.lane)
            try:
                return operation()
            finally:
                active.pop()

    body = b"\x1aE\xdf\xa3" + b"header" + b"\x1fC\xb6u" + b"audio"

    def resolve(*_args: Any) -> dict[str, Any]:
        assert active == ["extraction"]
        return {"url": "https://test.googlevideo.com/audio", "protocol": "https", "ext": "webm"}

    def chunks(*_args: Any) -> Iterator[tuple[bytes, int]]:
        assert active == ["transfer"]
        yield body[:14], len(body)
        yield body[14:], len(body)

    def legacy(*_args: Any) -> Any:
        raise AssertionError("Background download still occupies extraction lane")

    monkeypatch.setattr(stream, "YTMUSIC_SPOOL_DIR", tmp_path)
    monkeypatch.setattr(stream, "_extraction_budget", Budget("extraction"))
    monkeypatch.setattr(stream, "_spool_transfer_budget", Budget("transfer"))
    monkeypatch.setattr(stream, "_get_stream_url_sync", resolve)
    monkeypatch.setattr(stream, "_iter_progressive_cdn_chunks", chunks)
    monkeypatch.setattr(stream, "_extract_spool_with_retry", legacy)
    stream._spool_cancel_events[session.key] = cancel
    try:
        path, content_type = await stream._download_ytmusic_spool_bounded(
            "dQw4w9WgXcQ",
            "MEDIUM",
            playback=False,
            session=session,
        )
        await asyncio.sleep(0)  # Flush worker notifications before checking publication.
        assert calls == ["extraction", "transfer"]
        assert await asyncio.to_thread(Path(path).read_bytes) == body
        assert content_type == "audio/webm"
        assert not session.readable
        assert session.partial_path is None, "Analysis must still wait for a complete file"
    finally:
        session.release_pins()
        stream._spool_cancel_events.pop(session.key, None)
        stream._yt_dlp_spool_executor.shutdown(wait=True)
        stream._spool_transfer_executor.shutdown(wait=True)


@pytest.mark.anyio
async def test_cancelled_background_plan_does_not_contact_provider(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    import ytmusic_stream as stream

    cancel = threading.Event()
    cancel.set()
    session = stream._SpoolSession(
        "dQw4w9WgXcQ:MEDIUM",
        asyncio.get_running_loop(),
        cancel,
        allow_growing=False,
        priority=0,
    )

    def reject(*_args: Any) -> Any:
        raise AssertionError("Cancelled background request reached provider")

    monkeypatch.setattr(stream, "_get_stream_url_sync", reject)
    with pytest.raises(stream._SpoolDownloadCancelled):
        stream._resolve_progressive_spool_plan_sync("dQw4w9WgXcQ", "MEDIUM", session)
