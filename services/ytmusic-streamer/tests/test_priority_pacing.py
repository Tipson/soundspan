"""Playback owns the next paced slot without increasing the request rate."""

import queue
import threading
from concurrent.futures import ThreadPoolExecutor

import pytest


@pytest.mark.parametrize("fails", [False, True])
def test_resolver_binds_priority_and_restores_thread_context(monkeypatch, fails):
    from types import SimpleNamespace

    import ytmusic_stream as stream
    from ytmusic_startup_timing import SpoolStartupTiming

    session = SimpleNamespace(
        current_priority=lambda: 2,
        cancel_event=threading.Event(),
        startup_timing=SpoolStartupTiming(),
    )

    def resolve(*_args):
        assert stream._extract_pacer._priority()() == 2
        if fails:
            raise ValueError("controlled")
        return {"url": "https://cdn.test/audio", "protocol": "https", "ext": "webm"}

    monkeypatch.setattr(stream, "_get_stream_url_sync", resolve)
    if fails:
        with pytest.raises(ValueError):
            stream._resolve_progressive_spool_plan_sync("test", "HIGH", session)
    else:
        assert stream._resolve_progressive_spool_plan_sync("test", "HIGH", session)
    assert stream._extract_pacer._priority()() == 0


@pytest.mark.parametrize("reason", ["cancel", "deadline"])
def test_waiter_can_leave_without_consuming_a_slot(reason):
    from ytmusic_extraction_budget import ExtractionAbandoned
    from ytmusic_priority_pacer import PriorityRatePacer

    now = [0.0]
    cancel = threading.Event()
    waiting = threading.Event()
    pacer = PriorityRatePacer(
        10,
        10,
        priority=lambda: lambda: 0,
        clock=lambda: now[0],
        max_wait=5,
        cancelled=cancel.is_set,
    )
    pacer.wait()

    def priority():
        waiting.set()
        return 0

    pacer._priority = lambda: priority
    with ThreadPoolExecutor(max_workers=1) as executor:
        future = executor.submit(pacer.wait)
        assert waiting.wait(timeout=1)
        with pacer._condition:
            if reason == "cancel":
                cancel.set()
            else:
                now[0] = 6
            pacer._condition.notify_all()
        with pytest.raises(ExtractionAbandoned):
            future.result(timeout=1)
    assert not pacer._waiters
    assert pacer._next_allowed == 10


def test_playback_overtakes_waiting_preload_without_burst():
    from ytmusic_priority_pacer import PriorityRatePacer

    now = [0.0]
    local = threading.local()
    entered = {1: threading.Event(), 2: threading.Event()}
    results = queue.Queue()

    def priority():
        level = getattr(local, "level", 0)

        def current():
            if level:
                entered[level].set()
            return level

        return current

    pacer = PriorityRatePacer(10, 10, priority=priority, clock=lambda: now[0])
    pacer.wait()

    def wait(level):
        local.level = level
        pacer.wait()
        results.put((level, now[0]))

    def advance(value):
        with pacer._condition:
            now[0] = value
            pacer._condition.notify_all()

    with ThreadPoolExecutor(max_workers=2) as executor:
        preload = executor.submit(wait, 1)
        try:
            assert entered[1].wait(timeout=1)
            playback = executor.submit(wait, 2)
            assert entered[2].wait(timeout=1)
            assert results.empty()
            advance(10)
            assert results.get(timeout=1) == (2, 10)
            assert results.empty() and not preload.done()
            advance(20)
            assert results.get(timeout=1) == (1, 20)
            playback.result(timeout=1)
        finally:
            advance(100)
            preload.result(timeout=1)
    assert not pacer._waiters
