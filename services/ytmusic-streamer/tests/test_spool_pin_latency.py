"""A busy on-disk cache must not block the event loop's reader leases."""

import asyncio
import threading
import time
from pathlib import Path

import pytest


@pytest.mark.anyio
async def test_reader_pins_do_not_wait_for_a_directory_sweep(tmp_path):
    import ytmusic_stream as stream

    path = tmp_path / "abcdefghijk-HIGH.webm"
    held = threading.Event()
    release = threading.Event()

    def sweep():
        with stream._spool_prune_lock:
            held.set()
            release.wait(0.5)

    worker = threading.Thread(target=sweep)
    worker.start()
    assert await asyncio.to_thread(held.wait, 2)
    session = stream._SpoolSession(
        "abcdefghijk:HIGH", asyncio.get_running_loop(), threading.Event(), allow_growing=True
    )
    try:
        started = time.monotonic()
        session.publish_readable(path, "audio/webm", 100)
        assert path in stream._spool_pinned_paths
        session.release_pins()
        elapsed = time.monotonic() - started
        assert path not in stream._spool_pinned_paths
        assert elapsed < 0.15, f"Reader blocked on directory maintenance for {elapsed:.3f}s"
    finally:
        release.set()
        await asyncio.to_thread(worker.join, 2)


def test_eviction_rechecks_a_pin_acquired_after_the_scan(tmp_path, monkeypatch):
    import ytmusic_stream as stream
    from fastapi import HTTPException

    monkeypatch.setattr(stream, "YTMUSIC_SPOOL_DIR", tmp_path)
    monkeypatch.setattr(stream, "YTMUSIC_SPOOL_MAX_BYTES", 10)
    monkeypatch.setattr(stream, "YTMUSIC_SPOOL_TRACK_MAX_BYTES", 6)
    path = tmp_path / "abcdefghijk-HIGH.webm"
    path.write_bytes(b"audio")
    original = stream._collect_spool_entries

    def scan_then_pin():
        snapshot = original()
        stream._pin_spool_path(path)
        return snapshot

    monkeypatch.setattr(stream, "_collect_spool_entries", scan_then_pin)
    try:
        with pytest.raises(HTTPException) as error:
            stream._reserve_spool_bytes()
        assert error.value.status_code == 503
        assert path.read_bytes() == b"audio"
        assert stream._spool_reserved_bytes == 0
    finally:
        stream._unpin_spool_path(path)


def test_directory_accounting_reuses_file_metadata(tmp_path, monkeypatch):
    import ytmusic_stream as stream

    path = tmp_path / "abcdefghijk-HIGH.webm"
    path.write_bytes(b"audio")
    monkeypatch.setattr(stream, "YTMUSIC_SPOOL_DIR", tmp_path)
    original_stat = Path.stat
    reads = {}

    def limited_stat(candidate, *args, **kwargs):
        if candidate.parent == tmp_path:
            reads[candidate] = reads.get(candidate, 0) + 1
            assert reads[candidate] <= 1, "The same inode was queried twice during one sweep"
        return original_stat(candidate, *args, **kwargs)

    monkeypatch.setattr(Path, "stat", limited_stat)
    total, entries = stream._collect_spool_entries()
    assert total == 5
    assert [(size, candidate) for _, size, candidate in entries] == [(5, path)]
