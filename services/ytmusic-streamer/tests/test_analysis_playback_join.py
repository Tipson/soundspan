"""A listener joining analysis must not inherit its complete-file-only wait."""

import asyncio
from pathlib import Path
from typing import Any

import pytest


class ConnectedRequest:
    """Expose only the request surfaces consumed by the stream route."""

    def __init__(self) -> None:
        self.headers = {"range": "bytes=0-3"}

    async def is_disconnected(self) -> bool:
        return False


@pytest.mark.anyio
@pytest.mark.parametrize("join_after_prefix", [False, True])
@pytest.mark.parametrize("purpose", ["interactive", "preload"])
async def test_playback_join_uses_analysis_prefix_without_finishing_analysis(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
    join_after_prefix: bool,
    purpose: str,
) -> None:
    import ytmusic_stream as stream

    started = asyncio.Event()
    publish = asyncio.Event()
    published = asyncio.Event()
    finish = asyncio.Event()
    partial = tmp_path / "shared.webm.soundspan-part"
    completed = tmp_path / "dQw4w9WgXcQ-HIGH.webm"
    prefix = b"\x1aE\xdf\xa3\x1fC\xb6u"
    tail = b"remaining audio"
    downloads = 0

    async def download(*_args: Any, session: Any, **_kwargs: Any) -> tuple[str, str]:
        nonlocal downloads
        downloads += 1
        started.set()
        await publish.wait()
        partial.write_bytes(prefix)
        session.publish_readable(partial, "audio/webm", len(prefix + tail))
        published.set()
        await finish.wait()
        partial.write_bytes(prefix + tail)
        partial.replace(completed)
        session.publish_growth()
        return str(completed), "audio/webm"

    monkeypatch.setattr(stream, "YTMUSIC_SPOOL_DIR", tmp_path)
    monkeypatch.setattr(stream, "_download_ytmusic_spool_bounded", download)
    analysis = asyncio.create_task(
        stream.proxy_stream(
            "dQw4w9WgXcQ",
            ConnectedRequest(),
            user_id="__public__",
            quality="HIGH",
            purpose="analysis",
        )
    )
    playback = None
    response = None
    analysis_response = None
    try:
        await asyncio.wait_for(started.wait(), 1)
        if join_after_prefix:
            publish.set()
            await asyncio.wait_for(published.wait(), 1)
        playback = asyncio.create_task(
            stream.proxy_stream(
                "dQw4w9WgXcQ",
                ConnectedRequest(),
                user_id="__public__",
                quality="HIGH",
                purpose=purpose,
            )
        )
        await asyncio.sleep(0)
        publish.set()
        await asyncio.wait_for(published.wait(), 1)
        response = await asyncio.wait_for(asyncio.shield(playback), 0.3)
        assert response.status_code == 206
        assert response.headers["content-range"] == f"bytes 0-3/{len(prefix + tail)}"
        assert b"".join([chunk async for chunk in response.body_iterator]) == prefix[:4]
        assert not analysis.done(), "Analysis must still wait for the complete file"
        assert downloads == 1, "Do not start a second provider download"
        session = stream._spool_sessions["dQw4w9WgXcQ:HIGH"]
        assert not session.cancel_event.is_set(), "The analysis reader retains its lease"
        finish.set()
        analysis_response = await asyncio.wait_for(analysis, 1)
        assert isinstance(analysis_response, stream.FileResponse)
        assert await asyncio.to_thread(Path(analysis_response.path).read_bytes) == prefix + tail
    finally:
        publish.set()
        finish.set()
        tasks = [analysis] + ([playback] if playback is not None else [])
        results = await asyncio.gather(*tasks, return_exceptions=True)
        if response is not None:
            await response.body_iterator.aclose()
        for result in results:
            if isinstance(result, stream.FileResponse):
                result._release_pin()
        await asyncio.sleep(0)
    assert stream._spool_pin_counts == {}
    assert stream._spool_waiters == {}
