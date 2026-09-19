"""Startup phase measurements are bounded and use a monotonic clock."""

import asyncio
import logging
import threading

import pytest


def test_first_marks_are_retained_and_snapshots_are_detached():
    from ytmusic_startup_timing import SpoolStartupTiming

    now = [10.0]
    trace = SpoolStartupTiming(clock=lambda: now[0])
    now[0] = 10.5
    trace.mark("resolve_start")
    now[0] = 12.0
    trace.mark("resolved")
    now[0] = 13.0
    trace.mark("resolve_start")
    assert trace.snapshot() == {"resolve_start": 500, "resolved": 2000}
    snapshot = trace.snapshot()
    snapshot.clear()
    assert len(trace.snapshot()) == 2


@pytest.mark.anyio
async def test_resolution_and_publication_log_once_without_signed_url(
    monkeypatch, caplog, tmp_path
):
    import ytmusic_stream as stream

    session = stream._SpoolSession(
        "test:HIGH", asyncio.get_running_loop(), threading.Event(), allow_growing=True
    )
    monkeypatch.setattr(
        stream,
        "_get_stream_url_sync",
        lambda *_: {
            "url": "https://cdn.test/audio?secret=do-not-log",
            "protocol": "https",
            "ext": "webm",
        },
    )
    stream._resolve_progressive_spool_plan_sync("test", "HIGH", session)
    with caplog.at_level(logging.INFO):
        session.publish_readable(tmp_path / "audio.webm", "audio/webm", 100)
        session.publish_readable(tmp_path / "audio.webm", "audio/webm", 100)
    session.release_pins()
    assert set(session.startup_timing.snapshot()) == {"resolve_start", "resolved", "readable"}
    assert caplog.text.count("YouTube startup") == 1
    assert "do-not-log" not in caplog.text
