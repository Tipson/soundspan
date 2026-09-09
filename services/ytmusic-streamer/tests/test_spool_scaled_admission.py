"""Configured extraction parallelism must have bounded matching spool admission."""

import asyncio

import pytest
from fastapi import HTTPException


@pytest.mark.parametrize(("configured", "limit"), [(2, 2), (8, 8), (16, 16), (1000, 16)])
def test_cdn_parallelism_is_configurable_and_bounded(monkeypatch, configured, limit):
    monkeypatch.setenv("YTMUSIC_SPOOL_CONCURRENCY", str(configured))
    import ytmusic_stream as stream

    assert stream._spool_transfer_budget._limit == limit


@pytest.mark.anyio
@pytest.mark.parametrize(("workers", "capacity"), [(2, 16), (8, 64), (16, 128), (1000, 128)])
async def test_configured_workers_admit_bounded_cold_batch(monkeypatch, workers, capacity):
    monkeypatch.setenv("YTMUSIC_YTDLP_EXTRACT_CONCURRENCY", str(workers))
    import ytmusic_stream as stream

    release = asyncio.Event()

    async def download(*_args, **_kwargs):
        await release.wait()
        return "/controlled/completed.webm", "audio/webm"

    monkeypatch.setattr(stream, "_download_ytmusic_spool_bounded", download)
    admitted = []
    try:
        for index in range(capacity):
            key = f"cold-{index}:HIGH"
            admitted.append(stream._create_spool_task(key, f"cold-{index}", "HIGH"))
        # Coalescing remains legal at capacity; one new distinct key is rejected.
        assert stream._try_get_or_create_spool_task("cold-0:HIGH", "cold-0", "HIGH") is admitted[0]
        with pytest.raises(HTTPException) as error:
            stream._create_spool_task("extra:HIGH", "extra", "HIGH")
        assert error.value.status_code == 503
        assert stream._spool_pending_jobs == capacity
    finally:
        release.set()
        await asyncio.gather(*admitted)
        await asyncio.sleep(0)
    assert stream._spool_pending_jobs == 0
    assert not stream._spool_tasks
