"""One transfer reuses HTTP connections without sharing cookies with another."""

import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from types import SimpleNamespace

import pytest
import requests


def test_ranges_reuse_connection_but_next_transfer_has_no_cookies(monkeypatch):
    import ytmusic_stream as stream

    seen = []
    payload = b"abcdefghijkl"

    class Handler(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"

        def do_GET(self):
            seen.append((self.client_address, self.headers.get("Cookie")))
            first, last = map(int, self.headers["Range"].removeprefix("bytes=").split("-"))
            self.send_response(206)
            self.send_header("Content-Range", f"bytes {first}-{last}/{len(payload)}")
            self.send_header("Content-Length", str(last - first + 1))
            self.send_header("ETag", '"stable"')
            self.send_header("Set-Cookie", "transfer=one; Path=/")
            self.end_headers()
            self.wfile.write(payload[first : last + 1])

        def log_message(self, *_args):
            pass

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    worker = threading.Thread(target=server.serve_forever, daemon=True)
    worker.start()
    monkeypatch.setenv("NO_PROXY", "127.0.0.1")
    monkeypatch.setattr(stream, "_SPOOL_CDN_RANGE_BYTES", 4)
    try:
        for _ in range(2):
            chunks = stream._iter_progressive_cdn_chunks(
                f"http://127.0.0.1:{server.server_port}/audio",
                {},
                SimpleNamespace(cancel_event=threading.Event()),
                len(payload),
                time.monotonic(),
            )
            assert b"".join(chunk for chunk, _ in chunks) == payload
        assert len(seen) == 6
        assert len({address for address, _ in seen[:3]}) == 1
        assert len({address for address, _ in seen[3:]}) == 1
        assert seen[0][1] is None and seen[3][1] is None
    finally:
        server.shutdown()
        server.server_close()
        worker.join(timeout=2)


@pytest.mark.parametrize("outcome", ["complete", "cancel", "error", "close"])
def test_transfer_closes_its_pool_on_every_exit(monkeypatch, outcome):
    import ytmusic_stream as stream

    clients = []
    closed = []

    class Client(requests.Session):
        def __init__(self):
            super().__init__()
            clients.append(self)

        def close(self):
            closed.append(self)
            super().close()

        def get(self, *_args, **_kwargs):
            if outcome == "error":
                raise requests.ConnectionError("controlled failure")
            response = requests.Response()
            response.status_code = 206
            response.headers.update({"Content-Range": "bytes 0-3/4", "Content-Length": "4"})
            response._content = b"abcd"
            response._content_consumed = True
            return response

    monkeypatch.setattr(stream.requests, "Session", Client)
    cancel = threading.Event()
    if outcome == "cancel":
        cancel.set()
    chunks = stream._iter_progressive_cdn_chunks(
        "https://cdn.test/audio", {}, SimpleNamespace(cancel_event=cancel), 4, time.monotonic()
    )
    if outcome == "error":
        with pytest.raises(requests.ConnectionError):
            next(chunks)
    elif outcome == "cancel":
        with pytest.raises(stream._SpoolDownloadCancelled):
            next(chunks)
    elif outcome == "close":
        assert next(chunks) == (b"abcd", 4)
        chunks.close()
    else:
        assert list(chunks) == [(b"abcd", 4)]
    assert len(clients) == 1
    assert closed == clients
