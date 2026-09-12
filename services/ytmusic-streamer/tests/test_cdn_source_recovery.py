"""Recover a refused continuation only after verifying the replacement prefix."""

import threading
from pathlib import Path
from types import SimpleNamespace
from typing import Any

import pytest
import requests

PAYLOAD = b"\x1aE\xdf\xa3\x1fC\xb6u" + b"abcdefghijklmnop"


@pytest.fixture()
def transfer(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> Any:
    import ytmusic_stream as stream

    monkeypatch.setattr(stream, "YTMUSIC_SPOOL_DIR", tmp_path)
    monkeypatch.setattr(stream, "_SPOOL_CDN_RANGE_BYTES", 8)
    monkeypatch.setattr(stream._extract_pacer, "wait", lambda: None)
    session = SimpleNamespace(
        cancel_event=threading.Event(),
        current_priority=lambda: 2,
        startup_timing=SimpleNamespace(mark=lambda *_: None),
        pin_path=lambda *_: None,
        publish_readable_from_worker=lambda *_: None,
        publish_growth_from_worker=lambda: None,
    )
    options = {"protocol": "https", "ext": "webm", "acodec": "opus", "vcodec": "none"}
    old = stream._ProgressiveSpoolPlan(
        "https://cdn.test/old", "webm", "audio/webm", {**options, "url": "https://cdn.test/old"}
    )
    calls: list[tuple[str, int]] = []
    resolves: list[int] = []
    state: dict[str, Any] = {"replacement": PAYLOAD, "reject_new": False, "cancel": False}

    def resolve(*_: Any) -> dict[str, Any]:
        resolves.append(1)
        return {**options, "url": "https://cdn.test/new"}

    monkeypatch.setattr(stream, "_get_stream_url_sync", resolve)

    def get(_client: requests.Session, url: str, **kwargs: Any) -> requests.Response:
        first, last = map(int, kwargs["headers"]["Range"][6:].split("-"))
        calls.append((url.rsplit("/", 1)[-1], first))
        response = requests.Response()
        response.url = url
        response._content_consumed = True
        if (url.endswith("old") and first > 0) or state["reject_new"]:
            if state["cancel"]:
                session.cancel_event.set()
            response.status_code = 403
            response._content = b""
        else:
            payload = PAYLOAD if url.endswith("old") else state["replacement"]
            last = min(last, len(payload) - 1)
            response.status_code = 206
            response.headers.update(
                {
                    "Content-Range": f"bytes {first}-{last}/{len(payload)}",
                    "Content-Length": str(last - first + 1),
                }
            )
            response._content = payload[first : last + 1]
        return response

    monkeypatch.setattr(requests.Session, "get", get)
    return stream, session, old, calls, resolves, state


def test_refused_continuation_refreshes_and_replays_matching_prefix(transfer: Any) -> None:
    stream, session, plan, calls, resolves, _ = transfer
    path, _, info = stream._download_progressive_spool_sync("abcdefghijk", "HIGH", session, plan)
    assert Path(path).read_bytes() == PAYLOAD
    assert info["url"].endswith("/new")
    assert resolves == [1]
    assert calls == [("old", 0), ("old", 8), ("new", 0), ("new", 8), ("new", 16)]


@pytest.mark.parametrize("replacement", [b"different" + PAYLOAD[9:], PAYLOAD + b"longer"])
def test_recovery_never_appends_a_different_representation(
    transfer: Any, replacement: bytes
) -> None:
    stream, session, plan, _, resolves, state = transfer
    state["replacement"] = replacement
    with pytest.raises(ValueError, match="representation"):
        stream._download_progressive_spool_sync("abcdefghijk", "HIGH", session, plan)
    assert resolves == [1]
    assert not (stream.YTMUSIC_SPOOL_DIR / "abcdefghijk-HIGH.webm").exists()
    assert (
        stream.YTMUSIC_SPOOL_DIR / "abcdefghijk-HIGH.webm.soundspan-part"
    ).read_bytes() == PAYLOAD[:8]


def test_cancelled_refusal_cannot_start_another_extraction(transfer: Any) -> None:
    stream, session, plan, calls, resolves, state = transfer
    state["cancel"] = True
    with pytest.raises(stream._SpoolDownloadCancelled):
        stream._download_progressive_spool_sync("abcdefghijk", "HIGH", session, plan)
    assert calls == [("old", 0), ("old", 8)]
    assert resolves == []


def test_repeated_refusal_exhausts_one_refresh(
    transfer: Any, monkeypatch: pytest.MonkeyPatch
) -> None:
    stream, session, plan, calls, resolves, state = transfer
    original = stream._get_stream_url_sync

    def resolve(*args: Any) -> Any:
        state["reject_new"] = True
        return original(*args)

    monkeypatch.setattr(stream, "_get_stream_url_sync", resolve)
    with pytest.raises(RuntimeError, match="recovery exhausted"):
        stream._download_progressive_spool_sync("abcdefghijk", "HIGH", session, plan)
    assert calls == [("old", 0), ("old", 8), ("new", 0)]
    assert resolves == [1]
