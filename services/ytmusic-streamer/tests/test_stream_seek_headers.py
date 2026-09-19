"""A progressive audio response must expose its known size to browser seeking."""

import asyncio
from pathlib import Path
from typing import Any

import pytest


class ConnectedRequest:
    """Keep the test reader connected while its writer is gated."""

    def __init__(self, range_header: str) -> None:
        self.headers = {"range": range_header} if range_header else {}

    async def is_disconnected(self) -> bool:
        return False


@pytest.mark.anyio
@pytest.mark.parametrize("range_header", ["", "bytes=0-"])
@pytest.mark.parametrize("purpose", ["interactive", "preload"])
@pytest.mark.parametrize("known_length", [True, False])
@pytest.mark.parametrize("conditional", [True, False])
async def test_known_length_is_exposed_before_download_finishes(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
    range_header: str,
    purpose: str,
    known_length: bool,
    conditional: bool,
) -> None:
    import ytmusic_stream as stream

    finish = asyncio.Event()
    prefix = b"webm-prefix"
    tail = b"audio-tail"
    partial = tmp_path / "audio.part"
    completed = tmp_path / "dQw4w9WgXcQ-HIGH.webm"

    async def download(*_args: Any, session: Any, **_kwargs: Any) -> tuple[str, str]:
        partial.write_bytes(prefix)
        session.publish_readable(
            partial, "audio/webm", len(prefix + tail) if known_length else None
        )
        await finish.wait()
        partial.write_bytes(prefix + tail)
        partial.replace(completed)
        session.publish_growth()
        return str(completed), "audio/webm"

    monkeypatch.setattr(stream, "YTMUSIC_SPOOL_DIR", tmp_path)
    monkeypatch.setattr(stream, "_download_ytmusic_spool_bounded", download)
    request = ConnectedRequest(range_header)
    if conditional:
        request.headers["if-range"] = '"old-representation"'
    response = await asyncio.wait_for(
        stream.proxy_stream(
            "dQw4w9WgXcQ",
            request,
            user_id="__public__",
            quality="HIGH",
            purpose=purpose,
        ),
        1,
    )
    session = stream._spool_sessions["dQw4w9WgXcQ:HIGH"]
    try:
        assert not session.task.done(), "Do not delay startup until the complete file"
        assert response.headers.get("content-length") == (
            str(len(prefix + tail)) if known_length else None
        )
        assert response.headers["accept-ranges"] == "bytes"
        ranged = range_header and known_length and not conditional
        assert response.status_code == (206 if ranged else 200)
        if ranged:
            assert (
                response.headers["content-range"]
                == f"bytes 0-{len(prefix + tail) - 1}/{len(prefix + tail)}"
            )
        assert await anext(response.body_iterator) == prefix
        finish.set()
        assert b"".join([chunk async for chunk in response.body_iterator]) == tail
    finally:
        finish.set()
        await session.task
        await response.body_iterator.aclose()
        response._lease.close()
    assert stream._spool_waiters == {}
    assert stream._spool_pin_counts == {}
