"""Retry a stalled CONNECT before headers, never replay a partially read range."""

import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from types import SimpleNamespace

import pytest
import requests


def response(start=0, end=3, total=4):
    result = requests.Response()
    result.status_code = 206
    result.headers.update(
        {
            "Content-Range": f"bytes {start}-{end}/{total}",
            "Content-Length": str(end - start + 1),
            "ETag": '"same"',
        }
    )
    result._content = b"abcd"
    result._content_consumed = True
    return result


def test_stalled_connection_retries_same_range(monkeypatch):
    import ytmusic_stream as stream

    calls = []

    def get(_url, **options):
        calls.append(options)
        if len(calls) == 1:
            raise requests.ReadTimeout("proxy CONNECT stalled")
        return response()

    monkeypatch.setattr(
        stream.requests.Session, "get", lambda _client, *args, **kwargs: get(*args, **kwargs)
    )
    session = SimpleNamespace(cancel_event=threading.Event(), current_priority=lambda: 2)
    assert list(
        stream._iter_progressive_cdn_chunks(
            "https://cdn.test/audio", {}, session, 4, time.monotonic()
        )
    ) == [(b"abcd", 4)]
    assert len(calls) == 2
    assert calls[0]["headers"] == calls[1]["headers"]
    assert 0 < calls[0]["timeout"][0] <= 3
    assert calls[0]["timeout"][1] > calls[0]["timeout"][0]


@pytest.mark.parametrize("stop", ["twice", "cancelled", "deadline"])
def test_retry_respects_attempt_limit_cancellation_and_deadline(monkeypatch, stop):
    import ytmusic_stream as stream

    session = SimpleNamespace(cancel_event=threading.Event(), current_priority=lambda: 2)
    clock = [100.0]
    calls = []
    monkeypatch.setattr(stream.time, "monotonic", lambda: clock[0])

    def get(*_args, **_kwargs):
        calls.append(1)
        if stop == "cancelled":
            session.cancel_event.set()
        if stop == "deadline":
            clock[0] += stream.YTMUSIC_SPOOL_DOWNLOAD_TIMEOUT + 1
        raise requests.ReadTimeout("proxy stalled")

    monkeypatch.setattr(
        stream.requests.Session, "get", lambda _client, *args, **kwargs: get(*args, **kwargs)
    )
    expected = {
        "twice": requests.ReadTimeout,
        "cancelled": stream._SpoolDownloadCancelled,
        "deadline": RuntimeError,
    }[stop]
    with pytest.raises(expected):
        list(stream._iter_progressive_cdn_chunks("https://cdn.test/audio", {}, session, 4, 100.0))
    assert len(calls) == (2 if stop == "twice" else 1)


def test_body_timeout_after_bytes_is_not_replayed(monkeypatch):
    import ytmusic_stream as stream

    calls = []
    upstream = response(0, 7, 8)

    def body(*_args, **_kwargs):
        yield b"abcd"
        raise requests.ReadTimeout("body stalled")

    upstream.iter_content = body

    def get(*_args, **_kwargs):
        calls.append(1)
        return upstream

    monkeypatch.setattr(
        stream.requests.Session, "get", lambda _client, *args, **kwargs: get(*args, **kwargs)
    )
    chunks = stream._iter_progressive_cdn_chunks(
        "https://cdn.test/audio",
        {},
        SimpleNamespace(cancel_event=threading.Event(), current_priority=lambda: 2),
        8,
        time.monotonic(),
    )
    assert next(chunks) == (b"abcd", 8)
    with pytest.raises(requests.ReadTimeout):
        next(chunks)
    assert len(calls) == 1


def test_continuation_connection_retry_keeps_offset_and_validator(monkeypatch):
    import ytmusic_stream as stream

    calls = []
    monkeypatch.setattr(stream, "_SPOOL_CDN_RANGE_BYTES", 4)

    def get(_url, **options):
        calls.append(options["headers"].copy())
        if len(calls) == 1:
            return response(0, 3, 8)
        if len(calls) == 2:
            raise requests.ConnectTimeout("next range tunnel stalled")
        return response(4, 7, 8)

    monkeypatch.setattr(
        stream.requests.Session, "get", lambda _client, *args, **kwargs: get(*args, **kwargs)
    )
    chunks = stream._iter_progressive_cdn_chunks(
        "https://cdn.test/audio",
        {},
        SimpleNamespace(cancel_event=threading.Event(), current_priority=lambda: 2),
        8,
        time.monotonic(),
    )
    assert b"".join(chunk for chunk, _ in chunks) == b"abcdabcd"
    assert [item["Range"] for item in calls] == ["bytes=0-3", "bytes=4-7", "bytes=4-7"]
    assert calls[1] == calls[2] == {"Range": "bytes=4-7", "If-Range": '"same"'}


def test_real_proxy_connect_timeout_uses_short_connect_budget(monkeypatch):
    import ytmusic_stream as stream

    entered = []
    release = threading.Event()

    class Proxy(BaseHTTPRequestHandler):
        def do_CONNECT(self):
            entered.append(self.path)
            if len(entered) == 1:
                release.wait(1)
            self.send_error(502)

        def log_message(self, *_args):
            pass

    server = ThreadingHTTPServer(("127.0.0.1", 0), Proxy)
    worker = threading.Thread(target=server.serve_forever, daemon=True)
    worker.start()
    real_get = requests.get

    def get(url, **options):
        return real_get(url, proxies={"https": f"http://127.0.0.1:{server.server_port}"}, **options)

    monkeypatch.setattr(
        stream.requests.Session, "get", lambda _client, *args, **kwargs: get(*args, **kwargs)
    )
    monkeypatch.setattr(stream, "_SPOOL_CONNECT_TIMEOUT_SECONDS", 0.1, raising=False)
    before = time.monotonic()
    try:
        with pytest.raises(requests.exceptions.ProxyError):
            list(
                stream._iter_progressive_cdn_chunks(
                    "https://example.invalid/audio",
                    {},
                    SimpleNamespace(cancel_event=threading.Event(), current_priority=lambda: 2),
                    4,
                    before,
                )
            )
        assert len(entered) == 2
        assert time.monotonic() - before < 0.8
    finally:
        release.set()
        server.shutdown()
        server.server_close()
        worker.join(timeout=2)
